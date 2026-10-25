// Finds a text in a screenshot with Vision's OCR (an app's label on the CarPlay screen). Prints one line per text
// read that contains it, case-insensitively: "x y text", its centre in the image's pixels from the top left. Every text
// read goes to stderr. Exit 1: not found. Usage: find-text <image.png> <text>
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

var found = false
for observation in request.results ?? [] {
  guard let text = observation.topCandidates(1).first?.string else { continue }
  let box = observation.boundingBox
  FileHandle.standardError.write(Data("read \"\(text)\" at \(box)\n".utf8))
  guard text.lowercased().contains(wanted) else { continue }
  // Vision's boxes are normalized, from the bottom left.
  print(Int(box.midX * Double(image.width)), Int((1 - box.midY) * Double(image.height)), text)
  found = true
}
exit(found ? 0 : 1)
