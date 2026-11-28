use super::*;
use crate::test_support::paged::paged;
use rawler::rawsource::{LazyBytes, RawSource};
use std::fs::File;
use std::io::Cursor;

const MIB: usize = 1 << 20;

fn pattern(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| ((i as u64).wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect()
}

struct Staged {
    bytes: Vec<u8>,
    file: PagedFile<File>,
    path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn staged(len: usize) -> Staged {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.bin");
    let bytes = pattern(len);
    std::fs::write(&path, &bytes).unwrap();
    Staged {
        file: paged(&path),
        bytes,
        path,
        _dir: dir,
    }
}

fn reads(file: &PagedFile<File>) -> (u32, u64) {
    (file.read_calls(), file.bytes_read())
}

#[test]
fn a_range_is_the_files_bytes_from_one_aligned_read() {
    let s = staged(16 * MIB + 7);
    assert_eq!(s.file.len(), s.bytes.len());
    assert_eq!(s.file.range(10, 100).unwrap(), &s.bytes[10..110]);
    assert_eq!(reads(&s.file), (1, MIB as u64));
    assert_eq!(s.file.range(MIB - 5, 5).unwrap(), &s.bytes[MIB - 5..MIB]);
    assert_eq!(reads(&s.file), (1, MIB as u64));
}

#[test]
fn a_range_crossing_into_unread_bytes_reads_only_those() {
    let s = staged(16 * MIB + 7);
    s.file.range(0, 8).unwrap();
    assert_eq!(
        s.file.range(MIB - 10, 20).unwrap(),
        &s.bytes[MIB - 10..MIB + 10]
    );
    assert_eq!(reads(&s.file), (2, 2 * MIB as u64));
    assert_eq!(
        s.file.range(MIB / 2, 2 * MIB).unwrap(),
        &s.bytes[MIB / 2..MIB / 2 + 2 * MIB]
    );
    assert_eq!(reads(&s.file), (3, 3 * MIB as u64));
    let far = 9 * MIB + 3;
    assert_eq!(
        s.file.range(far, 2 * MIB).unwrap(),
        &s.bytes[far..far + 2 * MIB]
    );
    assert_eq!(reads(&s.file), (4, 6 * MIB as u64));
}

#[test]
fn the_last_extent_stops_at_the_end_of_the_file() {
    let s = staged(16 * MIB + 7);
    let len = s.bytes.len();
    assert_eq!(s.file.range(len - 4, 4).unwrap(), &s.bytes[len - 4..]);
    assert_eq!(reads(&s.file), (1, 7));
}

#[test]
fn a_range_spanning_held_pieces_reads_only_the_gaps() {
    let s = staged(16 * MIB + 7);
    s.file.range(0, 8).unwrap();
    s.file.range(4 * MIB, 8).unwrap();
    assert_eq!(reads(&s.file), (2, 2 * MIB as u64));
    assert_eq!(
        s.file.range(MIB / 2, 5 * MIB).unwrap(),
        &s.bytes[MIB / 2..MIB / 2 + 5 * MIB]
    );
    assert_eq!(reads(&s.file), (4, 6 * MIB as u64));
}

#[test]
fn scattered_pieces_then_the_whole_file_never_read_a_byte_twice() {
    let s = staged(20 * MIB);
    for extent in 0..MAX_EXTENTS {
        let offset = 2 * extent * MIB + 11;
        assert_eq!(
            s.file.range(offset, 5).unwrap(),
            &s.bytes[offset..offset + 5]
        );
    }
    assert_eq!(
        reads(&s.file),
        (MAX_EXTENTS as u32, (MAX_EXTENTS * MIB) as u64)
    );
    let offset = 17 * MIB;
    assert_eq!(
        s.file.range(offset, 5).unwrap(),
        &s.bytes[offset..offset + 5]
    );
    assert!(s.file.bytes_read() <= s.bytes.len() as u64);
    let whole = (2 * MAX_EXTENTS as u32, s.bytes.len() as u64);
    assert_eq!(reads(&s.file), whole);
    assert_eq!(s.file.range(19 * MIB, MIB).unwrap(), &s.bytes[19 * MIB..]);
    assert_eq!(s.file.all(), s.bytes.as_slice());
    assert_eq!(reads(&s.file), whole);
}

#[test]
fn a_range_worth_half_the_file_reads_it_whole() {
    let s = staged(4 * MIB);
    assert_eq!(s.file.range(5, 3 * MIB).unwrap(), &s.bytes[5..5 + 3 * MIB]);
    assert_eq!(reads(&s.file), (1, 4 * MIB as u64));
}

#[test]
fn a_small_file_is_read_whole_at_once() {
    let s = staged(1000);
    assert_eq!(s.file.range(0, 4).unwrap(), &s.bytes[..4]);
    assert_eq!(s.file.range(996, 4).unwrap(), &s.bytes[996..]);
    assert_eq!(reads(&s.file), (1, 1000));
}

#[test]
fn all_is_every_byte_in_one_read() {
    let s = staged(3 * MIB + 1);
    assert_eq!(s.file.all(), s.bytes.as_slice());
    assert_eq!(s.file.range(MIB, 9).unwrap(), &s.bytes[MIB..MIB + 9]);
    assert_eq!(reads(&s.file), (1, s.bytes.len() as u64));
    assert!(s.file.failure().is_none());
}

#[test]
fn empty_and_out_of_bounds_ranges_read_nothing() {
    let s = staged(3 * MIB);
    assert!(s.file.range(3 * MIB, 0).unwrap().is_empty());
    let kind = |r: io::Result<&[u8]>| r.unwrap_err().kind();
    assert_eq!(
        kind(s.file.range(3 * MIB - 1, 2)),
        io::ErrorKind::UnexpectedEof
    );
    assert_eq!(
        kind(s.file.range(usize::MAX, 2)),
        io::ErrorKind::UnexpectedEof
    );
    assert_eq!(reads(&s.file), (0, 0));
    assert!(s.file.failure().is_none());
}

#[test]
fn a_file_cut_short_after_open_is_an_error_and_ends_the_reads() {
    let s = staged(8 * MIB);
    assert_eq!(s.file.range(0, 16).unwrap(), &s.bytes[..16]);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&s.path)
        .unwrap()
        .set_len(MIB as u64 + 100)
        .unwrap();
    let cut = s.file.range(MIB + 50, 200).unwrap_err();
    assert_eq!(cut.kind(), io::ErrorKind::UnexpectedEof);
    assert_eq!(
        s.file.failure().map(|e| e.kind()),
        Some(io::ErrorKind::UnexpectedEof)
    );
    assert_eq!(s.file.read_calls(), 2);
    assert!(s.file.range(5 * MIB, 4).is_err());
    assert!(s.file.all().is_empty());
    assert_eq!(s.file.read_calls(), 2);
    assert_eq!(s.file.range(8, 8).unwrap(), &s.bytes[8..16]);
}

fn outcome<T: PartialEq + std::fmt::Debug>(result: io::Result<T>) -> Result<T, io::ErrorKind> {
    result.map_err(|e| e.kind())
}

#[test]
fn the_lazy_reader_behaves_like_a_cursor() {
    let s = staged(3 * MIB + 17);
    let len = s.bytes.len() as i64;
    let source = RawSource::new_lazy(&s.file);
    assert_eq!(source.len(), s.bytes.len());
    let mut lazy = source.reader();
    let mut cursor = Cursor::new(s.bytes.as_slice());
    let seeks = [
        SeekFrom::Start(0),
        SeekFrom::Start(MIB as u64 - 3),
        SeekFrom::Current(40),
        SeekFrom::Current(-(MIB as i64)),
        SeekFrom::End(-9),
        SeekFrom::End(5),
        SeekFrom::Current(-(len + 100)),
        SeekFrom::End(-(len + 1)),
        SeekFrom::Start(2 * MIB as u64 + 1),
        SeekFrom::End(0),
        SeekFrom::Start(len as u64 - 2),
    ];
    for (step, seek) in seeks.into_iter().enumerate() {
        assert_eq!(
            outcome(lazy.seek(seek)),
            outcome(cursor.seek(seek)),
            "{seek:?}"
        );
        let size = [1usize, 7, 4096, 2 * MIB][step % 4];
        let (mut from_lazy, mut from_cursor) = (vec![0u8; size], vec![0u8; size]);
        if step % 2 == 0 {
            assert_eq!(
                outcome(lazy.read(&mut from_lazy)),
                outcome(cursor.read(&mut from_cursor))
            );
        } else {
            assert_eq!(
                outcome(lazy.read_exact(&mut from_lazy)),
                outcome(cursor.read_exact(&mut from_cursor))
            );
        }
        assert_eq!(from_lazy, from_cursor, "{seek:?}");
        assert_eq!(
            lazy.stream_position().unwrap(),
            cursor.stream_position().unwrap(),
            "{seek:?}"
        );
    }
    assert!(s.file.failure().is_none());
}

#[test]
fn an_empty_exact_read_succeeds_anywhere_like_a_cursor() {
    let s = staged(MIB + 5);
    let source = RawSource::new_lazy(&s.file);
    let mut lazy = source.reader();
    let mut cursor = Cursor::new(s.bytes.as_slice());
    for target in [0, s.bytes.len() as u64, s.bytes.len() as u64 + 9] {
        lazy.seek(SeekFrom::Start(target)).unwrap();
        cursor.seek(SeekFrom::Start(target)).unwrap();
        assert_eq!(
            outcome(lazy.read_exact(&mut [])),
            outcome(cursor.read_exact(&mut []))
        );
        assert_eq!(
            lazy.stream_position().unwrap(),
            cursor.stream_position().unwrap()
        );
    }
}

#[test]
fn lazy_views_match_a_borrowed_source() {
    let s = staged(3 * MIB + 17);
    let len = s.bytes.len() as u64;
    let lazy = RawSource::new_lazy(&s.file);
    let whole = RawSource::new_from_borrowed_slice(&s.bytes);
    let view = |r: io::Result<&[u8]>| r.map(<[u8]>::to_vec).map_err(|e| e.to_string());
    for (offset, size) in [
        (0, 4),
        (MIB as u64 - 1, 2),
        (len - 3, 3),
        (len - 3, 4),
        (len + 1, 0),
    ] {
        assert_eq!(
            view(lazy.subview(offset, size)),
            view(whole.subview(offset, size))
        );
    }
    for offset in [len - 5, len, len + 1] {
        assert_eq!(
            view(lazy.subview_until_eof(offset)),
            view(whole.subview_until_eof(offset))
        );
    }
    assert_eq!(lazy.buf(), whole.buf());
    assert_eq!(lazy.as_vec().unwrap(), s.bytes);
}
