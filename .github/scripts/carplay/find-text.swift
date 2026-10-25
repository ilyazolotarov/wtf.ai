// Finds a text in a screenshot with Vision's OCR (an app's label on the CarPlay home screen). Prints the centre of the
// first text containing it, in the image's pixels from the top left, and every text read to stderr. Exit 1: not
// found. Usage: find-text <image.png> <text>
import Foundation
import ImageIO
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3,
  let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: arguments[1]) as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write(Data("usage: find-text <image.png> <text>\n".utf8))
  exit(2)
}
let wanted = arguments[2].lowercased()

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
  try VNImageRequestHandler(cgImage: image).perform([request])
} catch {
  FileHandle.standardError.write(Data("OCR failed: \(error)\n".utf8))
  exit(2)
}

var found: CGRect?
for observation in request.results ?? [] {
  guard let text = observation.topCandidates(1).first?.string else { continue }
  FileHandle.standardError.write(Data("read \"\(text)\" at \(observation.boundingBox)\n".utf8))
  if found == nil, text.lowercased().contains(wanted) { found = observation.boundingBox }
}
guard let box = found else { exit(1) }
// Vision's boxes are normalized, from the bottom left.
print(Int(box.midX * Double(image.width)), Int((1 - box.midY) * Double(image.height)))
