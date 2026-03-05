# solana-treasury-vault

Treasury management with spending rate limits. DAOs and teams set maximum withdrawal amounts per period — no single actor can drain funds.

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white)
![Anchor](https://img.shields.io/badge/Anchor-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## Features

- Rate-limited withdrawals
- Configurable spending periods
- Multi-authority support
- Deposit tracking

## Program Instructions

`initialize` | `deposit` | `withdraw`

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet
```

## Project Structure

```
programs/
  solana-treasury-vault/
    src/
      lib.rs          # Program entry point and instructions
    Cargo.toml
tests/
  solana-treasury-vault.ts           # Integration tests
Anchor.toml             # Anchor configuration
```

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Purple Squirrel Media](https://purplesquirrelmedia.io)
