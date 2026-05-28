use std::path::Path;

fn main() {
    let path_str = std::env::args().nth(1).expect("usage: detect-cs <RAW>");
    let path = Path::new(&path_str);
    
    let bytes = std::fs::read(path).unwrap();
    let raw_image = raw_core::decode::decode_bytes(&bytes, "CR2").unwrap();
    
    println!("camera_make: {:?}", raw_image.camera_make);
    println!("camera_model: {:?}", raw_image.camera_model);
    
    let (profile, source) = raw_core::color::dcp::profile_for_with_source(&raw_image).unwrap();
    println!("profile source: {:?}", source);
    println!("profile illuminant: {:?}", profile.illuminant);
    println!("profile scene_cct: {:?}", profile.scene_cct);
    println!("profile scene_white_xyz: {:?}", profile.scene_white_xyz);
    println!("profile color_matrix: {:#?}", profile.color_matrix);
    println!("profile forward_matrix: {:#?}", profile.forward_matrix);
}
