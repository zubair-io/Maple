//! Shared native/browser GPU adjustment binding (#4317).
//! The existing browser model mapping and camera-frame white balance live here
//! so hosts use one implementation with the shared raw-gpu chain.
pub mod capture;
pub mod creative;
pub mod live_profile;
pub mod model;
pub mod white_balance;
pub use model::{build_full_chain_inputs, stripped_prefix_model, NoiseProfileInputs};
pub use white_balance::GpuWhiteBalance;
pub mod prefix;
pub mod prepare;
#[cfg(test)]
mod prepare_tests;
