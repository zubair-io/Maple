import Foundation

struct MuiPageEditorVM {
  let title: String
  let photoURL: URL?
  let infoTitle: String
}

func buildMuiPageEditorVM(photos: [MuiPageEditorPhoto], activePhotoId: String?) -> MuiPageEditorVM {
  let photo = photos.first { $0.id == activePhotoId }
  return MuiPageEditorVM(
    title: photo?.alt ?? "Editor",
    photoURL: photo?.url,
    infoTitle: photo?.alt ?? "No photo selected"
  )
}
