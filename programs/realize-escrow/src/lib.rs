use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sha256_hasher::hashv;

declare_id!("GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb");

pub const MAX_RECIPIENTS: usize = 64;
pub const MAX_APPEND: usize = 8;
pub const MAX_LIFETIME: i64 = 30 * 86400;
pub const MAX_PAUSE: i64 = 3600;
pub const PROTOCOL_VERSION: u16 = 2;
pub const CONFIG_SEED: &[u8] = b"config";
pub const CONFIG_LABEL: &[u8] = b"vox-realize-v1";

#[cfg(all(feature = "localnet", feature = "devnet"))]
compile_error!("select exactly one Realize deployment cluster feature");
#[cfg(all(feature = "localnet", feature = "mainnet"))]
compile_error!("select exactly one Realize deployment cluster feature");
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("select exactly one Realize deployment cluster feature");
#[cfg(not(any(feature = "localnet", feature = "devnet", feature = "mainnet")))]
compile_error!("select localnet, devnet, or mainnet feature");

pub const fn deployment_cluster() -> ClusterId {
    #[cfg(feature = "localnet")]
    {
        ClusterId::Localnet
    }
    #[cfg(feature = "devnet")]
    {
        ClusterId::Devnet
    }
    #[cfg(feature = "mainnet")]
    {
        ClusterId::MainnetBeta
    }
}

#[program]
pub mod realize_escrow {
    use super::*;

    /// Initializes the unique config PDA. Its signer must be the loader-v3 upgrade authority.
    /// Mint and token program become immutable for this deployment.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        quote_authority: Pubkey,
        fulfillment_authority: Pubkey,
    ) -> Result<()> {
        require!(
            quote_authority != Pubkey::default()
                && fulfillment_authority != Pubkey::default()
                && quote_authority != fulfillment_authority,
            EscrowError::Authority
        );
        require!(ctx.accounts.mint.decimals == 6, EscrowError::Mint);
        require!(
            ctx.accounts.mint.to_account_info().owner == &ctx.accounts.token_program.key(),
            EscrowError::TokenProgram
        );
        ctx.accounts.config.set_inner(Config {
            admin: ctx.accounts.admin.key(),
            quote_authority,
            fulfillment_authority,
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            cluster: deployment_cluster(),
            protocol_version: PROTOCOL_VERSION,
            revision: 0,
            pause_until: 0,
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    /// Settlement authorities may rotate only through the config admin.
    pub fn update_settlement_authorities(
        ctx: Context<AdminConfig>,
        quote_authority: Pubkey,
        fulfillment_authority: Pubkey,
    ) -> Result<()> {
        require!(
            quote_authority != Pubkey::default()
                && fulfillment_authority != Pubkey::default()
                && quote_authority != fulfillment_authority,
            EscrowError::Authority
        );
        let config = &mut ctx.accounts.config;
        config.quote_authority = quote_authority;
        config.fulfillment_authority = fulfillment_authority;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or(EscrowError::Overflow)?;
        Ok(())
    }

    /// Admin rotation requires both the current and replacement authority to sign.
    pub fn transfer_admin(ctx: Context<TransferAdmin>) -> Result<()> {
        ctx.accounts.config.admin = ctx.accounts.new_admin.key();
        ctx.accounts.config.revision = ctx
            .accounts
            .config
            .revision
            .checked_add(1)
            .ok_or(EscrowError::Overflow)?;
        Ok(())
    }

    /// Emergency pause is bounded to one hour and blocks new activity only.
    pub fn pause(ctx: Context<AdminConfig>, until: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            until >= now && until <= now.checked_add(MAX_PAUSE).ok_or(EscrowError::Overflow)?,
            EscrowError::Deadline
        );
        ctx.accounts.config.pause_until = until;
        Ok(())
    }

    pub fn create_escrow(ctx: Context<CreateEscrow>, args: CreateArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.config.active(now)?;
        require!(
            now < args.quote_expires_at
                && args.quote_expires_at <= args.refund_after
                && args.refund_after
                    <= now.checked_add(MAX_LIFETIME).ok_or(EscrowError::Overflow)?,
            EscrowError::Deadline
        );
        require!(
            args.recipient_count > 0
                && args.recipient_count as usize <= MAX_RECIPIENTS
                && args.total > 0,
            EscrowError::Allocation
        );
        require!(
            args.commission != [0; 32] && args.quote_hash != [0; 32] && args.commitment != [0; 32],
            EscrowError::Commitment
        );

        let config = &ctx.accounts.config;
        let expected_domain_hash = quote_domain_hash(
            config,
            &ctx.accounts.config.key(),
            &crate::ID,
            &ctx.accounts.payer.key(),
            &args,
        );
        require!(
            args.quote_domain_hash == expected_domain_hash,
            EscrowError::QuoteDomain
        );
        verify_quote_signature(
            &ctx.accounts.instructions.to_account_info(),
            config.quote_authority,
            &expected_domain_hash,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.set_inner(Escrow {
            config: config.key(),
            payer: ctx.accounts.payer.key(),
            commission: args.commission,
            quote_hash: args.quote_hash,
            quote_domain_hash: expected_domain_hash,
            commitment: args.commitment,
            running_hash: [0; 32],
            fulfillment_authority: config.fulfillment_authority,
            mint: config.mint,
            token_program: config.token_program,
            cluster: config.cluster,
            protocol_version: config.protocol_version,
            config_revision: config.revision,
            quote_expires_at: args.quote_expires_at,
            refund_after: args.refund_after,
            total: args.total,
            allocated: 0,
            paid: 0,
            claimed: 0,
            recipient_count: args.recipient_count,
            status: Status::Draft,
            fulfillment_hash: [0; 32],
            bump: ctx.bumps.escrow,
            payouts: vec![],
        });
        e.running_hash = e.header_hash(&crate::ID);
        ctx.accounts.quote_used.escrow = e.key();
        ctx.accounts.quote_used.quote_domain_hash = expected_domain_hash;
        Ok(())
    }

    pub fn append_payouts(ctx: Context<EditEscrow>, payouts: Vec<Payout>) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(e.status == Status::Draft, EscrowError::State);
        require!(
            !payouts.is_empty()
                && payouts.len() <= MAX_APPEND
                && e.payouts.len() + payouts.len() <= e.recipient_count as usize,
            EscrowError::Allocation
        );
        for p in payouts {
            require!(
                p.amount > 0 && p.recipient != Pubkey::default() && p.recipient != e.key(),
                EscrowError::Allocation
            );
            e.allocated = checked_allocation_sum(e.allocated, p.amount)?;
            require!(e.allocated <= e.total, EscrowError::Conservation);
            e.running_hash = next_hash(&e.running_hash, e.payouts.len() as u8, &p);
            e.payouts.push(p);
        }
        Ok(())
    }

    pub fn seal(ctx: Context<EditEscrow>) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(e.status == Status::Draft, EscrowError::State);
        require!(
            e.payouts.len() == e.recipient_count as usize && e.allocated == e.total,
            EscrowError::Conservation
        );
        require!(e.running_hash == e.commitment, EscrowError::Commitment);
        e.status = Status::Ready;
        Ok(())
    }

    pub fn fund(ctx: Context<Fund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.config.active(now)?;
        let e = &ctx.accounts.escrow;
        require!(e.status == Status::Ready, EscrowError::State);
        require!(now < e.quote_expires_at, EscrowError::Expired);
        require!(
            e.running_hash == e.commitment && e.allocated == e.total,
            EscrowError::Commitment
        );
        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.source,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.payer,
            e.total,
        )?;
        ctx.accounts.escrow.status = Status::Funded;
        Ok(())
    }

    /// The configured fulfillment authority can attest only to this funded commission once.
    pub fn attest(
        ctx: Context<Attest>,
        quote_hash: [u8; 32],
        fulfillment_hash: [u8; 32],
        success: bool,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.config.active(now)?;
        let e = &mut ctx.accounts.escrow;
        require!(e.status == Status::Funded, EscrowError::State);
        require!(now < e.refund_after, EscrowError::Expired);
        require!(
            quote_hash == e.quote_hash && fulfillment_hash != [0; 32],
            EscrowError::Commitment
        );
        e.fulfillment_hash = fulfillment_hash;
        e.status = if success {
            Status::Fulfilled
        } else {
            Status::Refundable
        };
        Ok(())
    }

    /// Permissionless claim, payable only to the exact committed recipient's ATA.
    pub fn claim(ctx: Context<Claim>, index: u8) -> Result<()> {
        let e = &ctx.accounts.escrow;
        let amount = e.claim_amount(index)?;
        let config = e.config;
        let commission = e.commission;
        let bump = [e.bump];
        let seeds: &[&[u8]] = &[b"escrow", config.as_ref(), &commission, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: e.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            6,
        )?;
        ctx.accounts.escrow.record_claim(index, amount)?;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        require!(
            e.status == Status::Refundable
                || (e.status == Status::Funded && Clock::get()?.unix_timestamp >= e.refund_after),
            EscrowError::RefundIneligible
        );
        transfer_escrow_funds(&ctx.accounts, e.total)?;
        ctx.accounts.escrow.status = Status::Refunded;
        Ok(())
    }

    pub fn cancel(ctx: Context<EditEscrow>) -> Result<()> {
        require!(
            matches!(ctx.accounts.escrow.status, Status::Draft | Status::Ready),
            EscrowError::State
        );
        ctx.accounts.escrow.status = Status::Canceled;
        Ok(())
    }

    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        let e = &mut ctx.accounts.escrow;
        require!(
            matches!(e.status, Status::Draft | Status::Ready),
            EscrowError::State
        );
        require!(
            Clock::get()?.unix_timestamp >= e.quote_expires_at,
            EscrowError::Deadline
        );
        e.status = Status::Expired;
        Ok(())
    }

    /// Donations do not change the quote. Terminal surplus returns only to the original payer.
    pub fn recover_surplus(ctx: Context<Refund>) -> Result<()> {
        require!(
            matches!(
                ctx.accounts.escrow.status,
                Status::Settled | Status::Refunded | Status::Canceled | Status::Expired
            ),
            EscrowError::State
        );
        let amount = ctx.accounts.vault.amount;
        transfer_escrow_funds(&ctx.accounts, amount)
    }
}

fn transfer_checked<'info>(
    token_program: &Program<'info, Token>,
    source: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    destination: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        6,
    )
}

fn transfer_escrow_funds<'info>(accounts: &Refund<'info>, amount: u64) -> Result<()> {
    let e = &accounts.escrow;
    let config = e.config;
    let commission = e.commission;
    let bump = [e.bump];
    let seeds: &[&[u8]] = &[b"escrow", config.as_ref(), &commission, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.vault.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.destination.to_account_info(),
                authority: e.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        6,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateArgs {
    pub commission: [u8; 32],
    /// Canonical accepted quote hash from the shared Realize protocol.
    pub quote_hash: [u8; 32],
    /// Quote hash signed by the configured quote authority for this deployment domain.
    pub quote_domain_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub total: u64,
    pub recipient_count: u8,
    pub quote_expires_at: i64,
    pub refund_after: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Payout {
    pub recipient: Pubkey,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClusterId {
    Localnet,
    Devnet,
    MainnetBeta,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Draft,
    Ready,
    Funded,
    Fulfilled,
    Refundable,
    Settled,
    Refunded,
    Canceled,
    Expired,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub quote_authority: Pubkey,
    pub fulfillment_authority: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub cluster: ClusterId,
    pub protocol_version: u16,
    pub revision: u64,
    pub pause_until: i64,
    pub bump: u8,
}
impl Config {
    pub const SPACE: usize = 8 + 5 * 32 + 1 + 2 + 8 + 8 + 1;
    pub fn active(&self, now: i64) -> Result<()> {
        require!(now >= self.pause_until, EscrowError::Paused);
        Ok(())
    }
}

#[account]
pub struct QuoteUsed {
    pub escrow: Pubkey,
    pub quote_domain_hash: [u8; 32],
}

#[account]
pub struct Escrow {
    pub config: Pubkey,
    pub payer: Pubkey,
    pub commission: [u8; 32],
    pub quote_hash: [u8; 32],
    pub quote_domain_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub running_hash: [u8; 32],
    pub fulfillment_authority: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub cluster: ClusterId,
    pub protocol_version: u16,
    pub config_revision: u64,
    pub quote_expires_at: i64,
    pub refund_after: i64,
    pub total: u64,
    pub allocated: u64,
    pub paid: u64,
    pub claimed: u64,
    pub recipient_count: u8,
    pub status: Status,
    pub fulfillment_hash: [u8; 32],
    pub bump: u8,
    pub payouts: Vec<Payout>,
}
impl Escrow {
    pub const SPACE: usize = 8 + 10 * 32 + 8 * 7 + 1 + 2 + 1 + 1 + 32 + 1 + 4 + MAX_RECIPIENTS * 40;

    pub fn header_hash(&self, program: &Pubkey) -> [u8; 32] {
        hashv(&[
            b"vox.realize.solana.escrow.v3\0",
            cluster_bytes(self.cluster),
            program.as_ref(),
            &self.protocol_version.to_le_bytes(),
            self.config.as_ref(),
            &self.config_revision.to_le_bytes(),
            &self.commission,
            &self.quote_hash,
            self.payer.as_ref(),
            self.fulfillment_authority.as_ref(),
            self.mint.as_ref(),
            self.token_program.as_ref(),
            &self.total.to_le_bytes(),
            &[self.recipient_count],
            &self.quote_expires_at.to_le_bytes(),
            &self.refund_after.to_le_bytes(),
        ])
        .to_bytes()
    }

    pub fn claim_amount(&self, index: u8) -> Result<u64> {
        require!(self.status == Status::Fulfilled, EscrowError::State);
        let p = self
            .payouts
            .get(index as usize)
            .ok_or(EscrowError::Allocation)?;
        require!(
            index < 64 && self.claimed & (1u64 << index) == 0,
            EscrowError::AlreadyClaimed
        );
        Ok(p.amount)
    }

    pub fn record_claim(&mut self, index: u8, amount: u64) -> Result<()> {
        require!(self.claim_amount(index)? == amount, EscrowError::Allocation);
        self.paid = self.paid.checked_add(amount).ok_or(EscrowError::Overflow)?;
        require!(self.paid <= self.total, EscrowError::Conservation);
        self.claimed |= 1u64 << index;
        let all = if self.recipient_count == 64 {
            u64::MAX
        } else {
            (1u64 << self.recipient_count) - 1
        };
        if self.claimed == all {
            require!(self.paid == self.total, EscrowError::Conservation);
            self.status = Status::Settled;
        }
        Ok(())
    }
}

pub fn quote_domain_hash(
    config: &Config,
    config_key: &Pubkey,
    program: &Pubkey,
    payer: &Pubkey,
    args: &CreateArgs,
) -> [u8; 32] {
    hashv(&[
        b"vox.realize.solana.quote-domain.v2\0",
        cluster_bytes(config.cluster),
        program.as_ref(),
        &config.protocol_version.to_le_bytes(),
        config_key.as_ref(),
        &config.revision.to_le_bytes(),
        config.mint.as_ref(),
        config.token_program.as_ref(),
        config.quote_authority.as_ref(),
        config.fulfillment_authority.as_ref(),
        &args.commission,
        &args.quote_hash,
        payer.as_ref(),
        &args.commitment,
        &args.total.to_le_bytes(),
        &[args.recipient_count],
        &args.quote_expires_at.to_le_bytes(),
        &args.refund_after.to_le_bytes(),
    ])
    .to_bytes()
}

const fn cluster_bytes(cluster: ClusterId) -> &'static [u8] {
    match cluster {
        ClusterId::Localnet => b"solana:localnet",
        ClusterId::Devnet => b"solana:devnet",
        ClusterId::MainnetBeta => b"solana:mainnet-beta",
    }
}

fn verify_quote_signature(
    instructions: &AccountInfo,
    expected_authority: Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let current =
        load_current_index_checked(instructions).map_err(|_| EscrowError::QuoteSignature)?;
    require!(current > 0, EscrowError::QuoteSignature);
    let ix = load_instruction_at_checked((current - 1) as usize, instructions)
        .map_err(|_| EscrowError::QuoteSignature)?;
    require!(
        ix.program_id == solana_sdk_ids::ed25519_program::ID,
        EscrowError::QuoteSignature
    );
    let data = ix.data;
    require!(
        data.len() >= 16 && data[0] == 1 && data[1] == 0,
        EscrowError::QuoteSignature
    );
    let sig_offset = read_u16(&data, 2)?;
    let sig_instruction = read_u16(&data, 4)?;
    let key_offset = read_u16(&data, 6)?;
    let key_instruction = read_u16(&data, 8)?;
    let message_offset = read_u16(&data, 10)?;
    let message_size = read_u16(&data, 12)?;
    let message_instruction = read_u16(&data, 14)?;
    require!(
        sig_instruction == u16::MAX
            && key_instruction == u16::MAX
            && message_instruction == u16::MAX
            && message_size == 32,
        EscrowError::QuoteSignature
    );
    let signature_start = usize::from(sig_offset);
    let public_key_start = usize::from(key_offset);
    let message_start = usize::from(message_offset);
    let signature = data
        .get(signature_start..signature_start.saturating_add(64))
        .ok_or(EscrowError::QuoteSignature)?;
    let public_key = data
        .get(public_key_start..public_key_start.saturating_add(32))
        .ok_or(EscrowError::QuoteSignature)?;
    let message = data
        .get(message_start..message_start.saturating_add(usize::from(message_size)))
        .ok_or(EscrowError::QuoteSignature)?;
    require!(signature.len() == 64, EscrowError::QuoteSignature);
    require!(
        public_key == expected_authority.as_ref(),
        EscrowError::QuoteSignature
    );
    require!(message == expected_message, EscrowError::QuoteDomain);
    Ok(())
}

fn read_u16(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data.get(at..at + 2).ok_or(EscrowError::QuoteSignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

pub fn next_hash(previous: &[u8; 32], index: u8, p: &Payout) -> [u8; 32] {
    hashv(&[
        b"vox.realize.solana.payout.v3\0",
        previous,
        &[index],
        p.recipient.as_ref(),
        &p.amount.to_le_bytes(),
    ])
    .to_bytes()
}

pub fn checked_allocation_sum(current: u64, amount: u64) -> Result<u64> {
    current
        .checked_add(amount)
        .ok_or_else(|| error!(EscrowError::Overflow))
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [CONFIG_SEED, CONFIG_LABEL],
        bump
    )]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::RealizeEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EscrowError::Authority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, CONFIG_LABEL], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, CONFIG_LABEL], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(args: CreateArgs)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, CONFIG_LABEL], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = payer, space = Escrow::SPACE, seeds = [b"escrow", config.key().as_ref(), args.commission.as_ref()], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(init, payer = payer, space = 8 + 64, seeds = [b"quote", config.key().as_ref(), args.quote_hash.as_ref()], bump)]
    pub quote_used: Account<'info, QuoteUsed>,
    #[account(address = config.mint @ EscrowError::Mint, constraint = mint.decimals == 6 @ EscrowError::Mint)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = payer, seeds = [b"vault", escrow.key().as_ref()], bump, token::mint = mint, token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = config.token_program @ EscrowError::TokenProgram)]
    pub token_program: Program<'info, Token>,
    /// CHECK: Address is the runtime instructions sysvar; its contents are parsed with checked APIs.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EditEscrow<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.config.as_ref(), escrow.commission.as_ref()], bump = escrow.bump, has_one = payer)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, CONFIG_LABEL], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"escrow", escrow.config.as_ref(), escrow.commission.as_ref()], bump = escrow.bump, has_one = payer, has_one = config, constraint = escrow.mint == config.mint @ EscrowError::Mint, constraint = escrow.token_program == config.token_program @ EscrowError::TokenProgram)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = config.mint @ EscrowError::Mint, constraint = mint.decimals == 6 @ EscrowError::Mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = payer)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump, token::mint = mint, token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = config.token_program @ EscrowError::TokenProgram)]
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    #[account(address = escrow.fulfillment_authority @ EscrowError::Authority)]
    pub fulfillment_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, CONFIG_LABEL], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"escrow", escrow.config.as_ref(), escrow.commission.as_ref()], bump = escrow.bump, has_one = config)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"escrow", escrow.config.as_ref(), escrow.commission.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = escrow.mint @ EscrowError::Mint, constraint = mint.decimals == 6 @ EscrowError::Mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump, token::mint = mint, token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: Exact committed recipient is checked; no signature or account data is trusted.
    #[account(address = escrow.payouts.get(index as usize).ok_or(EscrowError::Allocation)?.recipient @ EscrowError::Recipient)]
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = recipient, associated_token::token_program = token_program)]
    pub destination: Account<'info, TokenAccount>,
    #[account(address = escrow.token_program @ EscrowError::TokenProgram)]
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.config.as_ref(), escrow.commission.as_ref()], bump = escrow.bump, has_one = payer)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = escrow.mint @ EscrowError::Mint, constraint = mint.decimals == 6 @ EscrowError::Mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", escrow.key().as_ref()], bump, token::mint = mint, token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = payer, associated_token::token_program = token_program)]
    pub destination: Account<'info, TokenAccount>,
    #[account(address = escrow.token_program @ EscrowError::TokenProgram)]
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(mut, seeds = [b"escrow", escrow.config.as_ref(), escrow.commission.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
}

#[error_code]
pub enum EscrowError {
    #[msg("Unauthorized authority")]
    Authority,
    #[msg("Invalid deadlines or pause duration")]
    Deadline,
    #[msg("Invalid allocation")]
    Allocation,
    #[msg("Commitment mismatch")]
    Commitment,
    #[msg("Invalid state transition")]
    State,
    #[msg("Integer overflow")]
    Overflow,
    #[msg("Payout conservation violated")]
    Conservation,
    #[msg("Quote or fulfillment window expired")]
    Expired,
    #[msg("Recipient already paid")]
    AlreadyClaimed,
    #[msg("Refund is not eligible")]
    RefundIneligible,
    #[msg("New activity paused")]
    Paused,
    #[msg("Wrong configured mint or precision")]
    Mint,
    #[msg("Wrong token program")]
    TokenProgram,
    #[msg("Wrong recipient")]
    Recipient,
    #[msg("Quote signature instruction is missing or malformed")]
    QuoteSignature,
    #[msg("Quote settlement domain does not match this deployment")]
    QuoteDomain,
}
