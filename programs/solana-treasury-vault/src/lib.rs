use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Ews62Jxt9GSpFhMSuvweRBSQkyZhnMdCokDp9DpUcchx");

#[program]
pub mod solana_treasury_vault {
    use super::*;

    pub fn initialize_treasury(ctx: Context<InitializeTreasury>, spending_limit: u64) -> Result<()> {
        let treasury = &mut ctx.accounts.treasury;
        treasury.authority = ctx.accounts.authority.key();
        treasury.mint = ctx.accounts.mint.key();
        treasury.spending_limit = spending_limit;
        treasury.spent_this_period = 0;
        treasury.period_start = Clock::get()?.unix_timestamp;
        treasury.period_length = 86400; // 24h default
        treasury.bump = ctx.bumps.treasury;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        token::transfer(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ), amount)?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let treasury = &mut ctx.accounts.treasury;
        let now = Clock::get()?.unix_timestamp;

        // Reset period if elapsed
        let elapsed = now.checked_sub(treasury.period_start).ok_or(TreasuryError::Overflow)?;
        if elapsed >= treasury.period_length {
            treasury.spent_this_period = 0;
            treasury.period_start = now;
        }

        let new_spent = treasury.spent_this_period.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        require!(new_spent <= treasury.spending_limit, TreasuryError::SpendingLimitExceeded);
        treasury.spent_this_period = new_spent;

        let authority_key = treasury.authority;
        let mint_key = treasury.mint;
        let bump = treasury.bump;
        let seeds: &[&[u8]] = &[b"treasury", authority_key.as_ref(), mint_key.as_ref(), &[bump]];

        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.treasury.to_account_info(),
            },
            &[seeds],
        ), amount)?;
        Ok(())
    }

    pub fn update_spending_limit(ctx: Context<UpdateTreasury>, new_limit: u64) -> Result<()> {
        ctx.accounts.treasury.spending_limit = new_limit;
        Ok(())
    }

    pub fn update_period_length(ctx: Context<UpdateTreasury>, new_length: i64) -> Result<()> {
        require!(new_length > 0, TreasuryError::InvalidPeriod);
        ctx.accounts.treasury.period_length = new_length;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = 8 + Treasury::INIT_SPACE,
        seeds = [b"treasury", authority.key().as_ref(), mint.key().as_ref()], bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(init, payer = authority, token::mint = mint, token::authority = treasury,
        seeds = [b"vault", treasury.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"vault", treasury.key().as_ref()], bump,
        token::mint = treasury.mint, token::authority = treasury)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = depositor_token_account.mint == treasury.mint)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"treasury", treasury.authority.as_ref(), treasury.mint.as_ref()],
        bump = treasury.bump, has_one = authority)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"vault", treasury.key().as_ref()], bump,
        token::mint = treasury.mint, token::authority = treasury)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = recipient_token_account.mint == treasury.mint)]
    pub recipient_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub treasury: Account<'info, Treasury>,
}

#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub spending_limit: u64,
    pub spent_this_period: u64,
    pub period_start: i64,
    pub period_length: i64,
    pub bump: u8,
}

#[error_code]
pub enum TreasuryError {
    #[msg("Spending limit exceeded for this period")]
    SpendingLimitExceeded,
    #[msg("Invalid period length")]
    InvalidPeriod,
    #[msg("Overflow")]
    Overflow,
}
