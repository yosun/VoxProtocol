use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use proptest::prelude::*;
use realize_escrow::{
    checked_allocation_sum, deployment_cluster, quote_domain_hash, ClusterId, Config, CreateArgs,
    Escrow, Payout, Status, CONFIG_LABEL, CONFIG_SEED, PROTOCOL_VERSION,
};

fn config() -> (Pubkey, Config) {
    let program = Pubkey::new_unique();
    let (address, bump) = Pubkey::find_program_address(&[CONFIG_SEED, CONFIG_LABEL], &program);
    let cfg = Config {
        admin: Pubkey::new_unique(),
        quote_authority: Pubkey::new_unique(),
        fulfillment_authority: Pubkey::new_unique(),
        mint: Pubkey::new_unique(),
        token_program: Token::id(),
        cluster: realize_escrow::deployment_cluster(),
        protocol_version: PROTOCOL_VERSION,
        revision: 0,
        pause_until: 0,
        bump,
    };
    (address, cfg)
}

#[test]
fn quote_domain_binds_cluster_program_version_config_and_authorities() {
    let (config_key, cfg) = config();
    let args = CreateArgs {
        commission: [8; 32],
        quote_hash: [19; 32],
        quote_domain_hash: [0; 32],
        commitment: [20; 32],
        total: 1_000_000,
        recipient_count: 3,
        quote_expires_at: 100,
        refund_after: 200,
    };
    let program = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let local = quote_domain_hash(&cfg, &config_key, &program, &payer, &args);
    let other_program = quote_domain_hash(&cfg, &config_key, &Pubkey::new_unique(), &payer, &args);
    let other_config = quote_domain_hash(&cfg, &Pubkey::new_unique(), &program, &payer, &args);
    assert_ne!(local, other_program);
    assert_ne!(local, other_config);
    let other_payer = quote_domain_hash(&cfg, &config_key, &program, &Pubkey::new_unique(), &args);
    assert_ne!(local, other_payer);
    let mut changed_commitment = args.clone();
    changed_commitment.commitment[0] ^= 1;
    assert_ne!(
        local,
        quote_domain_hash(&cfg, &config_key, &program, &payer, &changed_commitment)
    );
    let mut changed_commission = args.clone();
    changed_commission.commission[0] ^= 1;
    assert_ne!(
        local,
        quote_domain_hash(&cfg, &config_key, &program, &payer, &changed_commission)
    );
    let mut changed_deadline = args.clone();
    changed_deadline.refund_after += 1;
    assert_ne!(
        local,
        quote_domain_hash(&cfg, &config_key, &program, &payer, &changed_deadline)
    );
    let mut rotated = cfg;
    rotated.revision = 1;
    assert_ne!(
        local,
        quote_domain_hash(&rotated, &config_key, &program, &payer, &args)
    );
}

#[test]
fn deployment_cluster_is_selected_at_build_time() {
    #[cfg(feature = "localnet")]
    assert_eq!(deployment_cluster(), ClusterId::Localnet);
    #[cfg(feature = "devnet")]
    assert_eq!(deployment_cluster(), ClusterId::Devnet);
    #[cfg(feature = "mainnet")]
    assert_eq!(deployment_cluster(), ClusterId::MainnetBeta);
}

#[test]
fn integer_allocation_overflow_is_rejected() {
    assert_eq!(checked_allocation_sum(u64::MAX - 1, 1).unwrap(), u64::MAX);
    assert!(checked_allocation_sum(u64::MAX, 1).is_err());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn arbitrary_integer_allocations_claim_once_and_conserve(
        amounts in prop::collection::vec(1u64..1_000_000, 1..65),
        pivot in 0usize..64,
    ) {
        let (config, _) = config();
        let commission = [23; 32];
        let (_escrow_key, bump) = Pubkey::find_program_address(
            &[b"escrow", config.as_ref(), commission.as_ref()],
            &realize_escrow::ID,
        );
        let total: u64 = amounts.iter().sum();
        let payouts: Vec<Payout> = amounts.iter().map(|amount| Payout {
            recipient: Pubkey::new_unique(),
            amount: *amount,
        }).collect();
        let mut escrow = Escrow {
            config,
            payer: Pubkey::new_unique(),
            commission,
            quote_hash: [1; 32],
            quote_domain_hash: [2; 32],
            commitment: [3; 32],
            running_hash: [3; 32],
            fulfillment_authority: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            token_program: Token::id(),
            cluster: realize_escrow::deployment_cluster(),
            protocol_version: PROTOCOL_VERSION,
            config_revision: 0,
            quote_expires_at: 10,
            refund_after: 20,
            total,
            allocated: total,
            paid: 0,
            claimed: 0,
            recipient_count: amounts.len() as u8,
            status: Status::Fulfilled,
            fulfillment_hash: [4; 32],
            bump,
            payouts,
        };
        let mut paid = 0u64;
        for offset in 0..amounts.len() {
            let index = (pivot + offset) % amounts.len();
            let amount = escrow.claim_amount(index as u8).unwrap();
            escrow.record_claim(index as u8, amount).unwrap();
            paid += amount;
            prop_assert_eq!(escrow.paid, paid);
            prop_assert!(escrow.paid <= escrow.total);
            prop_assert!(escrow.claim_amount(index as u8).is_err());
        }
        prop_assert_eq!(escrow.paid, total);
        prop_assert_eq!(escrow.claimed, if amounts.len() == 64 { u64::MAX } else { (1u64 << amounts.len()) - 1 });
        prop_assert_eq!(escrow.status, Status::Settled);
    }
}
