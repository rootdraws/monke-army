// meteora_dlmm_cpi.rs
//
// Meteora DLMM CPI module for monke.army
// Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
//
// ALL discriminators verified against carbon-meteora-dlmm-decoder v0.12.0
// (extracted from on-chain IDL via codama). No fabricated values.
//
// V1 (standard SPL Token — primary for monke.army):
//   initialize_position          0xdbc0ea47bebf6650
//   add_liquidity_by_strategy_one_side 0x2905eeaf64e106cd
//   remove_liquidity_by_range    0x1a526698f04a691a
//   remove_all_liquidity         0x0a333d2370691855
//   claim_fee                    0xa9204f8988e84689
//   close_position               0x7b86510031446262
//   close_position_if_empty      0x3b7cd4765b986e9d
//   initialize_bin_array         0x235613b94ed44bd3
//
// V2 (Token-2022 — for future use):
//   remove_liquidity_by_range2   0xcc02c391359191cd
//   claim_fee2                   0x70bf65ab1c907fbb
//   close_position2              0xae5a2373ba2893e2

use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM ID & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

pub const METEORA_DLMM_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

pub const SPL_MEMO_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub const BINS_PER_ARRAY: i32 = 70;
pub const MAX_POSITION_WIDTH: i32 = 70;

// ═══════════════════════════════════════════════════════════════════════════
// DISCRIMINATORS — verified from carbon-meteora-dlmm-decoder v0.12.0
// ═══════════════════════════════════════════════════════════════════════════

pub mod disc {
    pub const INITIALIZE_POSITION: [u8; 8]          = [0xdb, 0xc0, 0xea, 0x47, 0xbe, 0xbf, 0x66, 0x50];
    pub const ADD_LIQ_BY_STRATEGY_ONE_SIDE: [u8; 8] = [0x29, 0x05, 0xee, 0xaf, 0x64, 0xe1, 0x06, 0xcd];
    pub const REMOVE_LIQ_BY_RANGE: [u8; 8]          = [0x1a, 0x52, 0x66, 0x98, 0xf0, 0x4a, 0x69, 0x1a];
    pub const REMOVE_ALL_LIQUIDITY: [u8; 8]          = [0x0a, 0x33, 0x3d, 0x23, 0x70, 0x69, 0x18, 0x55];
    pub const CLAIM_FEE: [u8; 8]                     = [0xa9, 0x20, 0x4f, 0x89, 0x88, 0xe8, 0x46, 0x89];
    pub const CLOSE_POSITION: [u8; 8]                = [0x7b, 0x86, 0x51, 0x00, 0x31, 0x44, 0x62, 0x62];
    pub const CLOSE_POSITION_IF_EMPTY: [u8; 8]       = [0x3b, 0x7c, 0xd4, 0x76, 0x5b, 0x98, 0x6e, 0x9d];
    pub const INITIALIZE_BIN_ARRAY: [u8; 8]          = [0x23, 0x56, 0x13, 0xb9, 0x4e, 0xd4, 0x4b, 0xd3];
    pub const REMOVE_LIQ_BY_RANGE2: [u8; 8]         = [0xcc, 0x02, 0xc3, 0x91, 0x35, 0x91, 0x91, 0xcd];
    pub const CLAIM_FEE2: [u8; 8]                    = [0x70, 0xbf, 0x65, 0xab, 0x1c, 0x90, 0x7f, 0xbb];
    pub const CLOSE_POSITION2: [u8; 8]               = [0xae, 0x5a, 0x23, 0x73, 0xba, 0x28, 0x93, 0xe2];
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum StrategyType {
    SpotOneSide,
    CurveOneSide,
    BidAskOneSide,
    SpotBalanced,
    CurveBalanced,
    BidAskBalanced,
    SpotImBalanced,
    CurveImBalanced,
    BidAskImBalanced,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StrategyParameters {
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    pub strategy_type: StrategyType,
    pub parameteres: [u8; 64], // typo is in Meteora's IDL
}

impl StrategyParameters {
    pub fn spot_one_side(min_bin_id: i32, max_bin_id: i32) -> Self {
        Self {
            min_bin_id,
            max_bin_id,
            strategy_type: StrategyType::SpotOneSide,
            parameteres: [0u8; 64],
        }
    }

    /// BidAsk distribution: more liquidity at the outer bins (higher prices for sell-side).
    /// Used for all rover positions — tokens sell at better prices as price pumps.
    pub fn bid_ask_one_side(min_bin_id: i32, max_bin_id: i32) -> Self {
        Self {
            min_bin_id,
            max_bin_id,
            strategy_type: StrategyType::BidAskOneSide,
            parameteres: [0u8; 64],
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LiquidityParameterByStrategyOneSide {
    pub amount: u64,
    pub active_id: i32,
    pub max_active_bin_slippage: i32,
    pub strategy_parameters: StrategyParameters,
}

// Token-2022 remaining_accounts_info (for v2 instructions)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum AccountsType {
    TransferHookX,
    TransferHookY,
    TransferHookReward,
    TransferHookMultiReward(u8),
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RemainingAccountsSlice {
    pub accounts_type: AccountsType,
    pub length: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RemainingAccountsInfo {
    pub slices: Vec<RemainingAccountsSlice>,
}

impl RemainingAccountsInfo {
    pub fn none() -> Self { Self { slices: vec![] } }
}

// ═══════════════════════════════════════════════════════════════════════════
// PDA HELPERS
// ═══════════════════════════════════════════════════════════════════════════

pub fn event_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"__event_authority"], &METEORA_DLMM_PROGRAM_ID)
}

pub fn bin_array_pda(lb_pair: &Pubkey, index: i64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"bin_array", lb_pair.as_ref(), &index.to_le_bytes()],
        &METEORA_DLMM_PROGRAM_ID,
    )
}

pub fn bin_id_to_array_index(bin_id: i32) -> i64 {
    if bin_id >= 0 {
        (bin_id / BINS_PER_ARRAY) as i64
    } else {
        ((bin_id - (BINS_PER_ARRAY - 1)) / BINS_PER_ARRAY) as i64
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// V1 INSTRUCTIONS (standard SPL Token)
// ═══════════════════════════════════════════════════════════════════════════

/// Accounts: payer(ms), position(ms), lb_pair, owner(s), system, rent, event_auth, program
pub fn initialize_position<'info>(
    accounts: &[AccountInfo<'info>; 8],
    lower_bin_id: i32,
    width: i32,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&disc::INITIALIZE_POSITION);
    data.extend_from_slice(&lower_bin_id.to_le_bytes());
    data.extend_from_slice(&width.to_le_bytes());

    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), true),           // payer
            AccountMeta::new(accounts[1].key(), true),           // position
            AccountMeta::new_readonly(accounts[2].key(), false), // lb_pair
            AccountMeta::new_readonly(accounts[3].key(), true),  // owner (vault signer)
            AccountMeta::new_readonly(accounts[4].key(), false), // system_program
            AccountMeta::new_readonly(accounts[5].key(), false), // rent
            AccountMeta::new_readonly(accounts[6].key(), false), // event_authority
            AccountMeta::new_readonly(accounts[7].key(), false), // program
        ],
        data,
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Accounts: position(m), lb_pair(m), bitmap_ext(m), user_token(m), reserve(m),
///           token_mint, bin_lower(m), bin_upper(m), sender(s), token_prog, event_auth, program
pub fn add_liquidity_by_strategy_one_side<'info>(
    accounts: &[AccountInfo<'info>; 12],
    params: LiquidityParameterByStrategyOneSide,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(100);
    data.extend_from_slice(&disc::ADD_LIQ_BY_STRATEGY_ONE_SIDE);
    params.serialize(&mut data)?;

    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),            // position
            AccountMeta::new(accounts[1].key(), false),            // lb_pair
            AccountMeta::new(accounts[2].key(), false),            // bitmap_ext
            AccountMeta::new(accounts[3].key(), false),            // user_token
            AccountMeta::new(accounts[4].key(), false),            // reserve
            AccountMeta::new_readonly(accounts[5].key(), false),   // token_mint
            AccountMeta::new(accounts[6].key(), false),            // bin_array_lower
            AccountMeta::new(accounts[7].key(), false),            // bin_array_upper
            AccountMeta::new_readonly(accounts[8].key(), true),    // sender
            AccountMeta::new_readonly(accounts[9].key(), false),   // token_program
            AccountMeta::new_readonly(accounts[10].key(), false),  // event_authority
            AccountMeta::new_readonly(accounts[11].key(), false),  // program
        ],
        data,
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Accounts: position(m), lb_pair(m), bitmap_ext(m), user_token_x(m), user_token_y(m),
///           reserve_x(m), reserve_y(m), token_x_mint, token_y_mint,
///           bin_lower(m), bin_upper(m), sender(s), token_x_prog, token_y_prog, event_auth, program
pub fn remove_liquidity_by_range<'info>(
    accounts: &[AccountInfo<'info>; 16],
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(18);
    data.extend_from_slice(&disc::REMOVE_LIQ_BY_RANGE);
    data.extend_from_slice(&from_bin_id.to_le_bytes());
    data.extend_from_slice(&to_bin_id.to_le_bytes());
    data.extend_from_slice(&bps_to_remove.to_le_bytes());

    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),            // position
            AccountMeta::new(accounts[1].key(), false),            // lb_pair
            AccountMeta::new(accounts[2].key(), false),            // bitmap_ext
            AccountMeta::new(accounts[3].key(), false),            // user_token_x
            AccountMeta::new(accounts[4].key(), false),            // user_token_y
            AccountMeta::new(accounts[5].key(), false),            // reserve_x
            AccountMeta::new(accounts[6].key(), false),            // reserve_y
            AccountMeta::new_readonly(accounts[7].key(), false),   // token_x_mint
            AccountMeta::new_readonly(accounts[8].key(), false),   // token_y_mint
            AccountMeta::new(accounts[9].key(), false),            // bin_array_lower
            AccountMeta::new(accounts[10].key(), false),           // bin_array_upper
            AccountMeta::new_readonly(accounts[11].key(), true),   // sender
            AccountMeta::new_readonly(accounts[12].key(), false),  // token_x_program
            AccountMeta::new_readonly(accounts[13].key(), false),  // token_y_program
            AccountMeta::new_readonly(accounts[14].key(), false),  // event_authority
            AccountMeta::new_readonly(accounts[15].key(), false),  // program
        ],
        data,
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Same accounts as remove_liquidity_by_range (16 accounts, same order). No params.
pub fn remove_all_liquidity<'info>(
    accounts: &[AccountInfo<'info>; 16],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),
            AccountMeta::new(accounts[1].key(), false),
            AccountMeta::new(accounts[2].key(), false),
            AccountMeta::new(accounts[3].key(), false),
            AccountMeta::new(accounts[4].key(), false),
            AccountMeta::new(accounts[5].key(), false),
            AccountMeta::new(accounts[6].key(), false),
            AccountMeta::new_readonly(accounts[7].key(), false),
            AccountMeta::new_readonly(accounts[8].key(), false),
            AccountMeta::new(accounts[9].key(), false),
            AccountMeta::new(accounts[10].key(), false),
            AccountMeta::new_readonly(accounts[11].key(), true),
            AccountMeta::new_readonly(accounts[12].key(), false),
            AccountMeta::new_readonly(accounts[13].key(), false),
            AccountMeta::new_readonly(accounts[14].key(), false),
            AccountMeta::new_readonly(accounts[15].key(), false),
        ],
        data: disc::REMOVE_ALL_LIQUIDITY.to_vec(),
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// NOTE: claim_fee account order differs — lb_pair is FIRST.
/// Accounts: lb_pair(m), position(m), bin_lower(m), bin_upper(m), sender(s),
///           reserve_x(m), reserve_y(m), user_token_x(m), user_token_y(m),
///           token_x_mint, token_y_mint, token_program, event_auth, program
pub fn claim_fee<'info>(
    accounts: &[AccountInfo<'info>; 14],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),            // lb_pair
            AccountMeta::new(accounts[1].key(), false),            // position
            AccountMeta::new(accounts[2].key(), false),            // bin_array_lower
            AccountMeta::new(accounts[3].key(), false),            // bin_array_upper
            AccountMeta::new_readonly(accounts[4].key(), true),    // sender
            AccountMeta::new(accounts[5].key(), false),            // reserve_x
            AccountMeta::new(accounts[6].key(), false),            // reserve_y
            AccountMeta::new(accounts[7].key(), false),            // user_token_x
            AccountMeta::new(accounts[8].key(), false),            // user_token_y
            AccountMeta::new_readonly(accounts[9].key(), false),   // token_x_mint
            AccountMeta::new_readonly(accounts[10].key(), false),  // token_y_mint
            AccountMeta::new_readonly(accounts[11].key(), false),  // token_program
            AccountMeta::new_readonly(accounts[12].key(), false),  // event_authority
            AccountMeta::new_readonly(accounts[13].key(), false),  // program
        ],
        data: disc::CLAIM_FEE.to_vec(),
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Accounts: position(m), lb_pair(m), bin_lower(m), bin_upper(m),
///           sender(s), rent_receiver(m), event_auth, program
pub fn close_position<'info>(
    accounts: &[AccountInfo<'info>; 8],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),
            AccountMeta::new(accounts[1].key(), false),
            AccountMeta::new(accounts[2].key(), false),
            AccountMeta::new(accounts[3].key(), false),
            AccountMeta::new_readonly(accounts[4].key(), true),
            AccountMeta::new(accounts[5].key(), false),
            AccountMeta::new_readonly(accounts[6].key(), false),
            AccountMeta::new_readonly(accounts[7].key(), false),
        ],
        data: disc::CLOSE_POSITION.to_vec(),
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Accounts: position(m), sender(s), rent_receiver(m), event_auth, program
pub fn close_position_if_empty<'info>(
    accounts: &[AccountInfo<'info>; 5],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),
            AccountMeta::new_readonly(accounts[1].key(), true),
            AccountMeta::new(accounts[2].key(), false),
            AccountMeta::new_readonly(accounts[3].key(), false),
            AccountMeta::new_readonly(accounts[4].key(), false),
        ],
        data: disc::CLOSE_POSITION_IF_EMPTY.to_vec(),
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Accounts: lb_pair, bin_array(m), funder(ms), system_program
pub fn initialize_bin_array<'info>(
    accounts: &[AccountInfo<'info>; 4],
    index: i64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&disc::INITIALIZE_BIN_ARRAY);
    data.extend_from_slice(&index.to_le_bytes());

    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts[0].key(), false),
            AccountMeta::new(accounts[1].key(), false),
            AccountMeta::new(accounts[2].key(), true),
            AccountMeta::new_readonly(accounts[3].key(), false),
        ],
        data,
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 INSTRUCTIONS (Token-2022 — bin arrays in remaining_accounts)
// ═══════════════════════════════════════════════════════════════════════════

/// V2 remove — no bin_array in fixed accounts, adds memo_program.
/// Accounts: position(m), lb_pair(m), bitmap_ext(m), user_token_x(m), user_token_y(m),
///           reserve_x(m), reserve_y(m), token_x_mint, token_y_mint, sender(s),
///           token_x_prog, token_y_prog, memo_prog, event_auth, program
///           + remaining (bin_arrays, transfer hooks)
pub fn remove_liquidity_by_range2<'info>(
    accounts: &[AccountInfo<'info>; 15],
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
    remaining_accounts_info: RemainingAccountsInfo,
    signer_seeds: &[&[&[u8]]],
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&disc::REMOVE_LIQ_BY_RANGE2);
    data.extend_from_slice(&from_bin_id.to_le_bytes());
    data.extend_from_slice(&to_bin_id.to_le_bytes());
    data.extend_from_slice(&bps_to_remove.to_le_bytes());
    remaining_accounts_info.serialize(&mut data)?;

    let mut metas = vec![
        AccountMeta::new(accounts[0].key(), false),
        AccountMeta::new(accounts[1].key(), false),
        AccountMeta::new(accounts[2].key(), false),
        AccountMeta::new(accounts[3].key(), false),
        AccountMeta::new(accounts[4].key(), false),
        AccountMeta::new(accounts[5].key(), false),
        AccountMeta::new(accounts[6].key(), false),
        AccountMeta::new_readonly(accounts[7].key(), false),
        AccountMeta::new_readonly(accounts[8].key(), false),
        AccountMeta::new_readonly(accounts[9].key(), true),
        AccountMeta::new_readonly(accounts[10].key(), false),
        AccountMeta::new_readonly(accounts[11].key(), false),
        AccountMeta::new_readonly(accounts[12].key(), false),
        AccountMeta::new_readonly(accounts[13].key(), false),
        AccountMeta::new_readonly(accounts[14].key(), false),
    ];
    for a in remaining_accounts { metas.push(AccountMeta::new(a.key(), false)); }
    let mut all: Vec<AccountInfo<'info>> = accounts.to_vec();
    all.extend_from_slice(remaining_accounts);
    invoke_signed(&Instruction { program_id: METEORA_DLMM_PROGRAM_ID, accounts: metas, data }, &all, signer_seeds)?;
    Ok(())
}

/// V2 claim — no bin_array in fixed accounts, separate token programs + memo.
/// Accounts: lb_pair(m), position(m), sender(s), reserve_x(m), reserve_y(m),
///           user_token_x(m), user_token_y(m), token_x_mint, token_y_mint,
///           token_prog_x, token_prog_y, memo_prog, event_auth, program
///           + remaining
pub fn claim_fee2<'info>(
    accounts: &[AccountInfo<'info>; 14],
    min_bin_id: i32,
    max_bin_id: i32,
    remaining_accounts_info: RemainingAccountsInfo,
    signer_seeds: &[&[&[u8]]],
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&disc::CLAIM_FEE2);
    data.extend_from_slice(&min_bin_id.to_le_bytes());
    data.extend_from_slice(&max_bin_id.to_le_bytes());
    remaining_accounts_info.serialize(&mut data)?;

    let mut metas = vec![
        AccountMeta::new(accounts[0].key(), false),
        AccountMeta::new(accounts[1].key(), false),
        AccountMeta::new_readonly(accounts[2].key(), true),
        AccountMeta::new(accounts[3].key(), false),
        AccountMeta::new(accounts[4].key(), false),
        AccountMeta::new(accounts[5].key(), false),
        AccountMeta::new(accounts[6].key(), false),
        AccountMeta::new_readonly(accounts[7].key(), false),
        AccountMeta::new_readonly(accounts[8].key(), false),
        AccountMeta::new_readonly(accounts[9].key(), false),
        AccountMeta::new_readonly(accounts[10].key(), false),
        AccountMeta::new_readonly(accounts[11].key(), false),
        AccountMeta::new_readonly(accounts[12].key(), false),
        AccountMeta::new_readonly(accounts[13].key(), false),
    ];
    for a in remaining_accounts { metas.push(AccountMeta::new(a.key(), false)); }
    let mut all: Vec<AccountInfo<'info>> = accounts.to_vec();
    all.extend_from_slice(remaining_accounts);
    invoke_signed(&Instruction { program_id: METEORA_DLMM_PROGRAM_ID, accounts: metas, data }, &all, signer_seeds)?;
    Ok(())
}

/// V2 close — no bin arrays needed. position(m), sender(s), rent_receiver(m), event_auth, program
pub fn close_position2<'info>(
    accounts: &[AccountInfo<'info>; 5],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),
            AccountMeta::new_readonly(accounts[1].key(), true),
            AccountMeta::new(accounts[2].key(), false),
            AccountMeta::new_readonly(accounts[3].key(), false),
            AccountMeta::new_readonly(accounts[4].key(), false),
        ],
        data: disc::CLOSE_POSITION2.to_vec(),
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════════════════════════

pub struct OpenPositionParams {
    pub lower_bin_id: i32,
    pub upper_bin_id: i32,
    pub amount: u64,
    pub active_bin_id: i32,
    pub max_slippage: i32,
}

impl OpenPositionParams {
    pub fn width(&self) -> i32 { self.upper_bin_id - self.lower_bin_id + 1 }

    pub fn to_liquidity_params(&self) -> LiquidityParameterByStrategyOneSide {
        LiquidityParameterByStrategyOneSide {
            amount: self.amount,
            active_id: self.active_bin_id,
            max_active_bin_slippage: self.max_slippage,
            strategy_parameters: StrategyParameters::spot_one_side(
                self.lower_bin_id, self.upper_bin_id,
            ),
        }
    }

    pub fn bin_array_indices(&self) -> (i64, i64) {
        (bin_id_to_array_index(self.lower_bin_id), bin_id_to_array_index(self.upper_bin_id))
    }
}
