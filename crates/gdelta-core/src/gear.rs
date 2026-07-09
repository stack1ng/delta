//! GEAR rolling hash implementation for fast pattern matching.
//!
//! The GEAR hash uses precomputed random values to create a rolling
//! fingerprint of data windows, enabling efficient similarity detection.
//!
//! Vendored from the MIT-licensed `gdelta` crate by Oliver Seifert
//! (<https://github.com/ImGajeed76/gdelta>), which implements the GDelta
//! algorithm by Haoliang Tan et al. See NOTICE at the repository root.

/// Word size for rolling hash window.
pub const WORD_SIZE: usize = 8;

/// Base sample rate for hash table insertion.
pub const BASE_SAMPLE_RATE: usize = 3;

/// GEAR hash matrix mapping 256 ASCII characters to random 64-bit values.
pub const GEAR_MX: [u64; 256] = [
    0xb088_d3a9_e840_f559,
    0x5652_c7f7_39ed_20d6,
    0x45b2_8969_8989_72ab,
    0x6b0a_89d5_b68e_c777,
    0x368f_573e_8b7a_31b7,
    0x1dc6_36dc_e936_d94b,
    0x207a_4c4e_5554_d5b6,
    0xa474_b346_2823_9acb,
    0x3b06_a83e_1ca3_b912,
    0x90e7_8d6c_2f02_baf7,
    0xe1c9_2df7_150d_9a8a,
    0x8e95_053a_1086_d3ad,
    0x5a2e_f4f1_b83a_0722,
    0xa50f_ac94_9f80_7fae,
    0x0e73_03eb_80d8_d681,
    0x99b0_7edc_1570_ad0f,
    0x689d_2fb5_55fd_3076,
    0x0000_5082_119e_a468,
    0xc4b0_8306_a88f_cc28,
    0x3eb0_678a_f637_4afd,
    0xf19f_87ab_86ad_7436,
    0xf212_9fbf_be6b_c736,
    0x4811_4957_5c98_a4ed,
    0x0000_0106_9547_7bc5,
    0x1fba_3780_1a9c_eacc,
    0x3bf0_6fd6_63a4_9b6d,
    0x9968_7e97_82e3_874b,
    0x79a1_0673_aa50_d8e3,
    0xe4ac_cf9e_6211_f420,
    0x2520_e71f_8757_9071,
    0x2bd5_d3fd_781a_8a9b,
    0x00de_4dcd_dd11_c873,
    0xeaa9_311c_5a87_392f,
    0xdb74_8eb6_17bc_40ff,
    0xaf57_9a8d_f620_bf6f,
    0x86a6_e5da_1b09_c2b1,
    0xcc2f_c30a_c322_a12e,
    0x355e_2afe_c1f7_4267,
    0x2d99_c8f4_c021_a47b,
    0xbade_4b4a_9404_cfc3,
    0xf7b5_1872_1d70_7d69,
    0x3286_b658_7bf3_2c20,
    0x0000_b688_86af_270c,
    0xa115_d6e4_db8a_9079,
    0x484f_7e9c_97b2_e199,
    0xccca_7bb7_5713_e301,
    0xbf25_84a6_2bb0_f160,
    0xade7_e813_625d_bcc8,
    0x0000_7094_0d87_955a,
    0x8ae6_9108_139e_626f,
    0xbd77_6ad7_2fde_38a2,
    0xfb6b_001f_c2fc_c0cf,
    0xc7a4_74b8_e67b_c427,
    0xbaf6_f116_10eb_5d58,
    0x09cb_1f5b_6de7_70d1,
    0xb0b2_19e6_977d_4c47,
    0x00cc_bc38_6ea7_ad4a,
    0xcc84_9d0a_df97_3f01,
    0x73a3_ef7d_016a_f770,
    0xc807_d2d3_86bd_bdfe,
    0x7f2a_c996_6c79_1730,
    0xd037_a86b_c6c5_04da,
    0xf3f1_7c66_1eaa_609d,
    0xaca6_26b0_4daa_e687,
    0x755a_9937_4f4a_5b07,
    0x9083_7ee6_5b2c_aede,
    0x6ee8_ad93_fd56_0785,
    0x0000_d9e1_1053_edd8,
    0x9e06_3bb2_d21c_dbd7,
    0x07ab_77f1_2a01_d2b2,
    0xec55_0255_e664_1b44,
    0x78fb_94a8_449c_14c6,
    0xc751_0e1b_c6c0_f5f5,
    0x0000_320b_36e4_cae3,
    0x827c_3326_2c8b_1a2d,
    0x1467_5f0b_48ea_4144,
    0x267b_d3a6_498d_eceb,
    0xf191_6ff9_82f5_035e,
    0x8622_1b7f_f434_fb88,
    0x9dbe_cee7_386f_49d8,
    0xea58_f8ca_c80f_8f4a,
    0x008d_1986_92fc_64d8,
    0x6d38_704f_babf_9a36,
    0xe032_cb07_d1e7_be4c,
    0x228d_21f6_ad45_0890,
    0x635c_b1bf_c025_89a5,
    0x4620_a173_9ca2_ce71,
    0xa7e7_dfe3_aae5_fb58,
    0x0c10_ca93_2b3c_0deb,
    0x2727_fee8_84af_ed7b,
    0xa2df_1c6d_f9e2_ab1f,
    0x4dcd_d1ac_0774_f523,
    0x0000_70ff_ad33_e24e,
    0xa2ac_e87b_c597_7816,
    0x9892_275a_b428_6049,
    0xc286_1181_ddf1_8959,
    0xbb99_72a0_4248_3e19,
    0xef70_cd37_6651_3078,
    0x0000_0513_abfc_9864,
    0xc058_b618_58c9_4083,
    0x09e8_5085_9725_e0de,
    0x9197_fb3b_f83e_7d94,
    0x7e1e_626d_12b6_4bce,
    0x520c_5450_7f7b_57d1,
    0xbee1_7971_74e2_2416,
    0x6fd9_ac32_22e9_5587,
    0x0023_957c_9adf_bf3e,
    0xa01c_7d7e_234b_be15,
    0xaba2_c758_b8a3_8cbb,
    0x0d1f_a0ce_ec3e_2b30,
    0x0bb6_a58b_7e60_b991,
    0x4333_dd5b_9fa2_6635,
    0xc2fd_3b7d_4001_c1a3,
    0xfb41_8024_5473_1127,
    0x65a5_6185_a50d_18cb,
    0xf67a_02bd_8784_b54f,
    0x696f_11dd_67e6_5063,
    0x0000_2022_fca8_14ab,
    0x8cd6_be91_2db9_d852,
    0x6951_89b6_e9ae_8a57,
    0xee94_53b5_0ada_0c28,
    0xd8fc_5ea9_1a78_845e,
    0xab86_bf19_1a4a_a767,
    0x0000_c6b5_c864_15e5,
    0x2673_1017_8e08_a22e,
    0xed2d_101b_078b_ca25,
    0x3b41_ed84_b226_a8fb,
    0x13e6_2212_0f28_dc06,
    0xa315_f5eb_fb70_6d26,
    0x8816_c34e_3301_bace,
    0xe939_5b9c_bb71_fdae,
    0x002c_e920_2e72_1648,
    0x4283_db1d_2bb3_c91c,
    0xd77d_461a_d2b1_a6a5,
    0xe2ec_17e4_6eeb_866b,
    0xb8e0_be40_39fb_c47c,
    0xdea1_60c4_d529_9d04,
    0x7eec_86c8_d28c_3634,
    0x2119_ad12_9f98_a399,
    0xa6cc_f46b_61a2_83ef,
    0x2c52_cede_f658_c617,
    0x2db4_8711_69ac_dd83,
    0x0000_f0d6_f39e_cbe9,
    0x3dd5_d8c9_8d2f_9489,
    0x8a18_72a2_2b01_f584,
    0xf282_a4c4_0e7b_3cf2,
    0x8020_ec2c_cb1b_a196,
    0x6693_b6e0_9e59_e313,
    0x0000_ce19_cc7c_83eb,
    0x20cb_5735_f647_9c3b,
    0x762e_bf37_59d7_5a5b,
    0x207b_fe82_3d69_3975,
    0xd77d_c112_339c_d9d5,
    0x9ba7_8342_8462_7d03,
    0x217d_c513_e95f_51e9,
    0xb27b_1a29_fc5e_7816,
    0x00d5_cd98_31bb_662d,
    0x71e3_9b80_6d75_734c,
    0x7e57_2af0_06fb_1a23,
    0xa273_4f2f_6ae9_1f85,
    0xbf82_c6b5_022c_ddf2,
    0x5c3b_eac6_0761_a0de,
    0xcdc8_93bb_4741_6998,
    0x6d10_8561_5c18_7e01,
    0x77f8_ae30_ac27_7c5d,
    0x917c_6b81_122a_2c91,
    0x5b75_b699_add1_6967,
    0x0000_cf6a_e79a_069b,
    0xf3c4_0afa_60de_1104,
    0x2063_127a_a591_67c3,
    0x621d_e622_69d1_894d,
    0xd188_ac1d_e62b_4726,
    0x1070_36e2_154b_673c,
    0x0000_b85f_2855_3a1d,
    0xf2ef_4e4c_1823_6f3d,
    0xd9d6_de66_11b9_f602,
    0xa1fc_7955_fb47_911c,
    0xeb85_fd03_2f29_8dbd,
    0xbe27_502f_b3be_fae1,
    0xe303_4251_c4cd_661e,
    0x4413_64d3_5407_1836,
    0x0082_b36c_75f2_983e,
    0xb145_9103_16fa_66f0,
    0x021c_069c_9847_caf7,
    0x2910_dfc7_5a4b_5221,
    0x735b_353e_1c57_a8b5,
    0xce44_312c_e98e_d96c,
    0xbc94_2e45_06bd_fa65,
    0xf050_86a7_1257_941b,
    0xfec3_b215_d351_cead,
    0x00ae_1055_e014_4202,
    0xf54b_4084_6f42_e454,
    0x0000_7fd9_c8bc_bcc8,
    0xbfbd_9ef3_17de_9bfe,
    0xa804_302f_f285_4e12,
    0x39ce_4957_a5e5_d8d4,
    0xffb9_e2a4_5637_ba84,
    0x55b9_ad1d_9ea0_818b,
    0x0000_8acb_f319_178a,
    0x48e2_bfc8_d0fb_fb38,
    0x8be3_9841_e848_b5e8,
    0x0e27_1216_0696_a08b,
    0xd510_96e8_4b44_242a,
    0x1101_ba17_6792_e13a,
    0xc22e_770f_4531_689d,
    0x1689_eff2_72bb_c56c,
    0x00a9_2a19_7f56_50ec,
    0xbc76_5990_bda1_784e,
    0xc614_41e3_92fc_b8ae,
    0x07e1_3a2c_ed31_e4a0,
    0x92cb_e984_234e_9d4d,
    0x8f4f_f572_bb7d_8ac5,
    0x0b96_70c0_0b96_3bd0,
    0x6295_5a58_1a03_eb01,
    0x645f_83e5_ea00_0254,
    0x41fc_e516_cd88_f299,
    0xbbda_9748_da7a_98cf,
    0x0000_aab2_fe48_45fa,
    0x1976_1b06_9bf5_6555,
    0x8b8f_5e83_43b6_ad56,
    0x3e5d_1cfd_1448_21d9,
    0xec5c_1e2c_a2b0_cd8f,
    0xfaf7_e0fe_a7fb_b57f,
    0x0000_00d3_ba12_961b,
    0xda3f_9017_8401_b18e,
    0x70ff_906d_e33a_5feb,
    0x0527_d5a7_c069_70e7,
    0x22d8_e773_607c_13e9,
    0xc9ab_70df_643c_3bac,
    0xeda4_c6dc_8abe_12e3,
    0xecef_1f41_0033_e78a,
    0x0024_c2b2_74ac_72cb,
    0x0674_0d95_4fa9_00b4,
    0x1d7a_299b_323d_6304,
    0xb3c3_7cb2_98cb_ead5,
    0xc986_e3c7_6178_739b,
    0x9fab_ea36_4b46_f58a,
    0x6da2_14c5_af85_cc56,
    0x17a4_3ed8_b7a3_8f84,
    0x6ecc_ec51_1d9a_dbeb,
    0xf9ca_b309_1333_5afb,
    0x4a5e_60c5_f415_eed2,
    0x0000_6967_5036_72b4,
    0x9da5_1d12_1454_bb87,
    0x8432_1e13_b9bb_c816,
    0xfb3d_6fb6_ab2f_dd8d,
    0x6030_5eed_8e16_0a8d,
    0xcbbf_4b14_e994_6ce8,
    0x0000_4f63_381b_10c3,
    0x07d5_b781_6fcc_4e10,
    0xe5a5_3672_6a6a_8155,
    0x57af_b234_47a0_7fdd,
    0x18f3_46f7_abc9_d394,
    0x636d_c655_d61a_d33d,
    0xcc8b_ab49_39f7_f3f6,
    0x63c7_a906_c1dd_187b,
];

/// Builds a hash table for the base data using GEAR rolling hash.
///
/// The hash table maps fingerprints to positions in the base data,
/// enabling fast lookup of potential matches during encoding.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_lossless)]
pub fn build_hash_table(base_data: &[u8], start: usize, end: usize, hash_bits: u32) -> Vec<u32> {
    let hash_size = 1usize << hash_bits;
    let mut hash_table = vec![0u32; hash_size];

    if end - start < WORD_SIZE {
        return hash_table;
    }

    let shift_bits = (64 / WORD_SIZE) + (64 % WORD_SIZE != 0) as usize;
    let index_shift = 64 - hash_bits;

    // Initialize fingerprint with first WORD_SIZE bytes
    let mut fingerprint = 0u64;
    for i in 0..WORD_SIZE {
        if start + i < end {
            // Use wrapping operations - overflow is intentional
            fingerprint = fingerprint
                .wrapping_shl(shift_bits as u32)
                .wrapping_add(GEAR_MX[base_data[start + i] as usize]);
        }
    }

    // Build hash table with sampling
    let mut pos = start;
    let num_chunks = end - start - WORD_SIZE;

    while pos < start + num_chunks {
        let index = (fingerprint >> index_shift) as usize;
        hash_table[index] = pos as u32;

        // Advance by BASE_SAMPLE_RATE positions
        for _ in 0..BASE_SAMPLE_RATE {
            if pos + WORD_SIZE < end {
                // Use wrapping operations - overflow is intentional
                fingerprint = fingerprint
                    .wrapping_shl(shift_bits as u32)
                    .wrapping_add(GEAR_MX[base_data[pos + WORD_SIZE] as usize]);
                pos += 1;
            } else {
                break;
            }
        }
    }

    hash_table
}

/// Computes a GEAR rolling hash fingerprint for a data window.
#[inline]
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_lossless)]
pub fn compute_fingerprint(data: &[u8], start: usize) -> u64 {
    let shift_bits = (64 / WORD_SIZE) + (64 % WORD_SIZE != 0) as usize;
    let mut fingerprint = 0u64;

    for i in 0..WORD_SIZE {
        if start + i < data.len() {
            // Use wrapping operations - overflow is intentional in hash computation
            fingerprint = fingerprint
                .wrapping_shl(shift_bits as u32)
                .wrapping_add(GEAR_MX[data[start + i] as usize]);
        }
    }

    fingerprint
}

/// Updates a rolling fingerprint by removing one byte and adding another.
#[inline]
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_lossless)]
pub fn roll_fingerprint(fingerprint: u64, new_byte: u8) -> u64 {
    let shift_bits = (64 / WORD_SIZE) + (64 % WORD_SIZE != 0) as usize;
    // Use wrapping operations - overflow is intentional in hash computation
    fingerprint
        .wrapping_shl(shift_bits as u32)
        .wrapping_add(GEAR_MX[new_byte as usize])
}
