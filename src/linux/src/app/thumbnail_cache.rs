use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

const FLOOR: usize = 128;

/// Evicting a tile still on screen would request it again without end, so the
/// cache holds at least as many thumbnails as the grid lays out.
pub(super) fn evict_oldest<K: Eq + Hash, V>(
    order: &mut VecDeque<K>,
    cache: &mut HashMap<K, V>,
    on_screen: usize,
    is_on_screen: impl Fn(&K) -> bool,
) {
    let capacity = on_screen.max(FLOOR);
    let mut spared = 0;
    while order.len() > capacity && spared < order.len() {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        if is_on_screen(&oldest) {
            order.push_back(oldest);
            spared += 1;
        } else {
            cache.remove(&oldest);
        }
    }
}
