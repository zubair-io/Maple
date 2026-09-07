use super::develop_non_raw;

#[test]
fn non_raw_manual_half_turn_moves_the_developed_pixels() {
    let width = 12;
    let height = 8;
    let pixels: Vec<f32> = (0..width * height)
        .flat_map(|i| {
            let value = 0.03 + i as f32 / (width * height) as f32 * 0.4;
            [value, value, value, 1.0]
        })
        .collect();
    let base = develop_non_raw(&pixels, width, height, None).unwrap();
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description xmlns:papp="http://ns.justmaple.app/1.0/" papp:GeoRotation="180"/>
      </rdf:RDF></x:xmpmeta>"#;
    let rotated = develop_non_raw(&pixels, width, height, Some(xmp.into())).unwrap();
    assert_eq!((rotated.width(), rotated.height()), (width, height));
    let base_rgb = base.rgb();
    let rotated_rgb = rotated.rgb();
    assert_ne!(base_rgb, rotated_rgb);
    for (a, b) in base_rgb
        .chunks_exact(3)
        .rev()
        .zip(rotated_rgb.chunks_exact(3))
    {
        assert!(a.iter().zip(b).all(|(x, y)| x.abs_diff(*y) <= 1));
    }
}
