//! Local grid thumbnails: a small worker pool over the shared on-share thumbnail tier.
mod disk;
mod embedded;
mod tile;
mod worker;

pub use worker::ThumbnailWorker;
