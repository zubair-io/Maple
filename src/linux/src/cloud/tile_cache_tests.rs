use super::tile_cache::TileCache;
use std::{
    sync::{Arc, Barrier},
    thread,
};

#[test]
fn two_tiles_published_at_once_for_one_address_never_mix_one_token_with_the_other_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let cache = Arc::new(TileCache::new(directory.path().to_owned(), 1 << 20));
    (0..300).for_each(|round| {
        let gate = Arc::new(Barrier::new(2));
        let publishers: Vec<_> = [("old", 1u8), ("new", 2u8)]
            .into_iter()
            .map(|(token, shade)| {
                let (cache, gate) = (cache.clone(), gate.clone());
                thread::spawn(move || {
                    gate.wait();
                    cache.store("https://maple", "photos:a.dng", Some(token), &[shade; 4096]);
                })
            })
            .collect();
        publishers
            .into_iter()
            .for_each(|publisher| publisher.join().unwrap());
        let held: Vec<_> = [("old", 1u8), ("new", 2u8)]
            .into_iter()
            .filter_map(|(token, shade)| {
                cache
                    .load("https://maple", "photos:a.dng", Some(token))
                    .map(|bytes| (bytes, shade))
            })
            .collect();
        assert_eq!(held.len(), 1, "round {round}: one token must hold");
        assert!(
            held[0].0.iter().all(|byte| *byte == held[0].1),
            "round {round}: a token was paired with the other tile's bytes"
        );
    });
}
