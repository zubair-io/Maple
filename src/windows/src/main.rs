//! Main entry point for Maple Windows native desktop app.

use maple_windows::WindowsSession;

fn main() {
    tracing_subscriber::fmt::init();
    tracing::info!("Starting Maple Native Windows Application");

    let mut session = WindowsSession::new();
    tracing::info!("Windows Host Session initialized successfully");

    // Print platform diagnostic info
    println!("Maple RAW Photo Editor — Windows Native Host v0.1.0");
    println!("Platform Target: Windows x64 / ARM64 (wgpu DX12/Vulkan active)");
    println!("Load-bearing: Scene-linear f32 Rec.2020 D65, AgX view transform, non-destructive XMP");

    if let Some(folder) = WindowsSession::pick_folder() {
        println!("Selected directory: {}", folder.display());
        if let Err(e) = session.set_active_directory(&folder) {
            eprintln!("Error watching folder: {e}");
        }
    }
}
