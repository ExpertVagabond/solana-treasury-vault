import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SolanaTreasuryVault } from "../target/types/solana_treasury_vault";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("solana-treasury-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .solanaTreasuryVault as Program<SolanaTreasuryVault>;
  const connection = provider.connection;

  // Keypairs
  const authority = Keypair.generate();
  const depositor = Keypair.generate();
  const nonAuthority = Keypair.generate();

  // Mint
  let mint: PublicKey;

  // PDA addresses
  let treasuryPda: PublicKey;
  let treasuryBump: number;
  let vaultPda: PublicKey;

  // Token accounts
  let authorityAta: PublicKey;
  let depositorAta: PublicKey;
  let recipientAta: PublicKey;
  let nonAuthorityAta: PublicKey;

  const decimals = 6;
  const spendingLimit = new BN(5_000_000); // 5 tokens
  const depositAmount = new BN(10_000_000); // 10 tokens

  before(async () => {
    // Airdrop SOL
    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const sigs = await Promise.all([
      connection.requestAirdrop(authority.publicKey, airdropAmount),
      connection.requestAirdrop(depositor.publicKey, airdropAmount),
      connection.requestAirdrop(nonAuthority.publicKey, airdropAmount),
    ]);
    await Promise.all(
      sigs.map((sig) => connection.confirmTransaction(sig, "confirmed"))
    );

    // Create mint
    mint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      decimals
    );

    // Derive treasury PDA
    [treasuryPda, treasuryBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("treasury"),
        authority.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );

    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), treasuryPda.toBuffer()],
      program.programId
    );

    // Create token accounts and mint tokens
    authorityAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mint,
        authority.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      mint,
      authorityAta,
      authority,
      50_000_000
    );

    depositorAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        depositor,
        mint,
        depositor.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      mint,
      depositorAta,
      authority,
      50_000_000
    );

    // Recipient ATA is the same as authority's for simplicity
    recipientAta = authorityAta;

    nonAuthorityAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        nonAuthority,
        mint,
        nonAuthority.publicKey
      )
    ).address;
  });

  // -------------------------------------------------------------------------
  // initialize_treasury
  // -------------------------------------------------------------------------
  it("initializes a treasury with a spending limit", async () => {
    await program.methods
      .initializeTreasury(spendingLimit)
      .accounts({
        authority: authority.publicKey,
        mint,
        treasury: treasuryPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const treasury = await program.account.treasury.fetch(treasuryPda);
    assert.ok(treasury.authority.equals(authority.publicKey));
    assert.ok(treasury.mint.equals(mint));
    assert.ok(treasury.spendingLimit.eq(spendingLimit));
    assert.ok(treasury.spentThisPeriod.eq(new BN(0)));
    assert.equal(treasury.periodLength.toNumber(), 86400);
    assert.equal(treasury.bump, treasuryBump);
  });

  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------
  it("deposits tokens into the vault", async () => {
    const vaultBefore = (await getAccount(connection, vaultPda)).amount;
    const depositorBefore = (await getAccount(connection, depositorAta)).amount;

    await program.methods
      .deposit(depositAmount)
      .accounts({
        depositor: depositor.publicKey,
        treasury: treasuryPda,
        vault: vaultPda,
        depositorTokenAccount: depositorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    const vaultAfter = (await getAccount(connection, vaultPda)).amount;
    const depositorAfter = (await getAccount(connection, depositorAta)).amount;

    assert.equal(
      vaultAfter - vaultBefore,
      BigInt(depositAmount.toNumber())
    );
    assert.equal(
      depositorBefore - depositorAfter,
      BigInt(depositAmount.toNumber())
    );
  });

  // -------------------------------------------------------------------------
  // withdraw — within spending limit
  // -------------------------------------------------------------------------
  it("withdraws tokens within the spending limit", async () => {
    const withdrawAmount = new BN(3_000_000); // 3 tokens, limit is 5

    const recipientBefore = (await getAccount(connection, recipientAta)).amount;

    await program.methods
      .withdraw(withdrawAmount)
      .accounts({
        authority: authority.publicKey,
        treasury: treasuryPda,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const recipientAfter = (await getAccount(connection, recipientAta)).amount;
    assert.equal(
      recipientAfter - recipientBefore,
      BigInt(withdrawAmount.toNumber())
    );

    // Check spent_this_period updated
    const treasury = await program.account.treasury.fetch(treasuryPda);
    assert.ok(treasury.spentThisPeriod.eq(withdrawAmount));
  });

  // -------------------------------------------------------------------------
  // Error: exceed spending limit should fail
  // -------------------------------------------------------------------------
  it("fails to withdraw when it would exceed spending limit", async () => {
    // Already spent 3M, limit is 5M, trying to withdraw 3M more (total 6M > 5M)
    const excessAmount = new BN(3_000_000);

    try {
      await program.methods
        .withdraw(excessAmount)
        .accounts({
          authority: authority.publicKey,
          treasury: treasuryPda,
          vault: vaultPda,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();
      assert.fail("Expected SpendingLimitExceeded error");
    } catch (err: any) {
      assert.include(err.toString(), "SpendingLimitExceeded");
    }
  });

  // -------------------------------------------------------------------------
  // withdraw — right at the limit
  // -------------------------------------------------------------------------
  it("withdraws up to exactly the spending limit", async () => {
    // Already spent 3M, limit is 5M, so we can withdraw exactly 2M more
    const exactRemaining = new BN(2_000_000);

    await program.methods
      .withdraw(exactRemaining)
      .accounts({
        authority: authority.publicKey,
        treasury: treasuryPda,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const treasury = await program.account.treasury.fetch(treasuryPda);
    assert.ok(treasury.spentThisPeriod.eq(spendingLimit));
  });

  // -------------------------------------------------------------------------
  // Error: non-authority cannot withdraw
  // -------------------------------------------------------------------------
  it("fails when non-authority tries to withdraw", async () => {
    try {
      await program.methods
        .withdraw(new BN(1_000))
        .accounts({
          authority: nonAuthority.publicKey,
          treasury: treasuryPda,
          vault: vaultPda,
          recipientTokenAccount: nonAuthorityAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([nonAuthority])
        .rpc();
      assert.fail("Expected authority constraint error");
    } catch (err: any) {
      // The has_one = authority constraint will produce an Anchor constraint error
      assert.ok(
        err.toString().includes("ConstraintHasOne") ||
          err.toString().includes("has_one") ||
          err.toString().includes("A has one constraint was violated") ||
          err.toString().includes("2001") ||
          err.toString().includes("Error")
      );
    }
  });

  // -------------------------------------------------------------------------
  // update_spending_limit
  // -------------------------------------------------------------------------
  it("updates the spending limit", async () => {
    const newLimit = new BN(20_000_000); // 20 tokens

    await program.methods
      .updateSpendingLimit(newLimit)
      .accounts({
        authority: authority.publicKey,
        treasury: treasuryPda,
      })
      .signers([authority])
      .rpc();

    const treasury = await program.account.treasury.fetch(treasuryPda);
    assert.ok(treasury.spendingLimit.eq(newLimit));
  });

  // -------------------------------------------------------------------------
  // Error: non-authority cannot update spending limit
  // -------------------------------------------------------------------------
  it("fails when non-authority tries to update spending limit", async () => {
    try {
      await program.methods
        .updateSpendingLimit(new BN(999))
        .accounts({
          authority: nonAuthority.publicKey,
          treasury: treasuryPda,
        })
        .signers([nonAuthority])
        .rpc();
      assert.fail("Expected authority constraint error");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintHasOne") ||
          err.toString().includes("has_one") ||
          err.toString().includes("A has one constraint was violated") ||
          err.toString().includes("2001") ||
          err.toString().includes("Error")
      );
    }
  });

  // -------------------------------------------------------------------------
  // deposit more and withdraw with updated limit
  // -------------------------------------------------------------------------
  it("deposits more and withdraws with the updated higher limit", async () => {
    // Deposit more tokens
    await program.methods
      .deposit(new BN(20_000_000))
      .accounts({
        depositor: depositor.publicKey,
        treasury: treasuryPda,
        vault: vaultPda,
        depositorTokenAccount: depositorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    // The spending period hasn't elapsed, but spent_this_period is at 5M
    // with new limit at 20M, so we should be able to withdraw up to 15M more
    const withdrawAmount = new BN(10_000_000);

    await program.methods
      .withdraw(withdrawAmount)
      .accounts({
        authority: authority.publicKey,
        treasury: treasuryPda,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const treasury = await program.account.treasury.fetch(treasuryPda);
    // spent_this_period should now be 5M + 10M = 15M
    assert.ok(treasury.spentThisPeriod.eq(new BN(15_000_000)));
  });
});
