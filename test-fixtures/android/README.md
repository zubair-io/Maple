`portrait.dng` is a copy of the committed `batch-transfer/source.dng` with EXIF
Orientation set to 6 (90° clockwise). It exercises orientation-aware portrait
layout through the real RAW decoder and GPU presenter. The source is unchanged.

Regenerate from the repository root:

```sh
cp test-fixtures/batch-transfer/source.dng test-fixtures/android/portrait.dng
exiftool -overwrite_original -Orientation#=6 test-fixtures/android/portrait.dng
```
