//! Native Linux Rust desktop shell. Incremental delivery is tracked by #4317;
//! resident GPU previews and release qualification remain.

pub mod controls;
pub mod library;
pub mod sidecar;

pub mod app;
pub mod jobs;

pub mod export;

pub mod cloud;

pub mod white_balance;

pub mod auto_adjust;

pub mod gpu_preview;

pub mod gpu_texture;

pub mod film;

pub mod detail;

mod detail_worker;
mod raster_detail;

mod whole_detail;
