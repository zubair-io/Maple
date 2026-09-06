use super::tests::{dummy_image, TEST_LOCK};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Barrier, Condvar};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Gate(Mutex<bool>, Condvar);
impl Gate {
    fn wait(&self) {
        let (open, timeout) = self
            .1
            .wait_timeout_while(self.0.lock().unwrap(), Duration::from_secs(5), |open| {
                !*open
            })
            .unwrap();
        assert!(*open && !timeout.timed_out(), "decode gate timed out");
    }
    fn open(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
}

#[test]
fn warm_cache_skips_raw_read_and_decode_closure() {
    let _guard = TEST_LOCK.lock().unwrap();
    clear_for_test();
    let key = CacheKey::Bytes { hash: 701 };
    let calls = AtomicUsize::new(0);
    let first = get_or_decode(&key, || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(dummy_image(7))
    })
    .unwrap();
    let second = get_or_decode(&key, || {
        calls.fetch_add(1, Ordering::Relaxed);
        panic!("warm file cache must not read or decode original bytes")
    })
    .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert!(Arc::ptr_eq(&first, &second));
    assert!(flights().lock().unwrap().is_empty());
}

#[test]
fn twenty_simultaneous_misses_share_one_native_decode() {
    let _guard = TEST_LOCK.lock().unwrap();
    clear_for_test();
    let key = CacheKey::Bytes { hash: 702 };
    let start = Barrier::new(21);
    let done = Gate::default();
    let calls = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..20)
            .map(|_| {
                scope.spawn(|| {
                    start.wait();
                    get_or_decode(&key, || {
                        calls.fetch_add(1, Ordering::Relaxed);
                        done.wait();
                        Ok(dummy_image(8))
                    })
                    .unwrap()
                })
            })
            .collect();
        start.wait();
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let joined = flights()
                .lock()
                .unwrap()
                .get(&key)
                .and_then(Weak::upgrade)
                .is_some_and(|value| Arc::strong_count(&value) >= 21);
            if joined {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "callers failed to join cold decode"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        // Capacity-one eviction cannot lose the result shared by these waiters.
        insert(CacheKey::Bytes { hash: 703 }, dummy_image(9));
        done.open();
        let images: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(images.iter().all(|image| Arc::ptr_eq(image, &images[0])));
    });
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert!(flights().lock().unwrap().is_empty());
}

#[test]
fn unrelated_raws_do_not_wait_on_a_global_decode_lock() {
    let _guard = TEST_LOCK.lock().unwrap();
    clear_for_test();
    let gate = Gate::default();
    let (sender, receiver) = mpsc::channel();
    std::thread::scope(|scope| {
        for hash in [704, 705] {
            let sender = &sender;
            let gate = &gate;
            scope.spawn(move || {
                get_or_decode(&CacheKey::Bytes { hash }, || {
                    sender.send(hash).unwrap();
                    gate.wait();
                    Ok(dummy_image(hash as u32))
                })
                .unwrap();
            });
        }
        let first = receiver.recv_timeout(Duration::from_secs(3));
        let second = receiver.recv_timeout(Duration::from_secs(3));
        gate.open();
        assert!(
            first.is_ok() && second.is_ok(),
            "different RAW keys must decode concurrently"
        );
    });
    assert!(flights().lock().unwrap().is_empty());
}

#[test]
fn failed_decode_retries_and_flights_leave_no_key_metadata() {
    let _guard = TEST_LOCK.lock().unwrap();
    clear_for_test();
    let key = CacheKey::Bytes { hash: 706 };
    assert!(get_or_decode(&key, || Err(crate::Error::Pipeline("transient".into()))).is_err());
    assert!(flights().lock().unwrap().is_empty());
    assert!(get_or_decode(&key, || Ok(dummy_image(1))).is_ok());
    for hash in 707..807 {
        get_or_decode(&CacheKey::Bytes { hash }, || Ok(dummy_image(2))).unwrap();
    }
    assert!(flights().lock().unwrap().is_empty());
}
