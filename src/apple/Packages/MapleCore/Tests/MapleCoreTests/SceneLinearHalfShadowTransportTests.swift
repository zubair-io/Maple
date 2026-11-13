import Metal
import RawPipeline
import XCTest

@testable import MapleCore

/// #4211: the actual linked Rust half-float chain and Metal texture consumer
/// must retain shadow samples. Swift's IEEE Float16 is an independent oracle.
private func nativeShadowOutput() throws -> [UInt16] {
  let values = (1...0x0400).flatMap { bits in
    [UInt16(bits), UInt16(bits) | 0x8000]
  }
  let input = values.flatMap { [$0, $0, $0, Float16(1).bitPattern] }
  var model = AdjustmentModel.default
  model.sharpenAmount = 0
  model.nrColor = 0
  var params = PipelineRenderer.makeParams(
    from: model, decodedTemperature: 6500, decodedTint: 0, skipAgX: true)
  var output = [UInt16](repeating: 0, count: input.count)
  let status = input.withUnsafeBufferPointer { source in
    output.withUnsafeMutableBufferPointer { destination in
      maple_apply_scene_linear_chain(
        source.baseAddress, UInt32(values.count), 1, &params, destination.baseAddress)
    }
  }
  XCTAssertEqual(status, 0)
  for (index, bits) in values.enumerated() {
    for channel in 0..<3 {
      XCTAssertEqual(
        output[index * 4 + channel], bits,
        "Native half chain changed signed shadow sample 0x\(String(bits, radix: 16))")
    }
    XCTAssertEqual(output[index * 4 + 3], Float16(1).bitPattern)
  }
  return output
}

final class SceneLinearHalfShadowTransportTests: XCTestCase {
  func testNativeHalfChainPreservesEverySignedSubnormalAndMinimumNormal() throws {
    _ = try nativeShadowOutput()
  }

}

final class SceneLinearHalfShadowMetalTests: XCTestCase {
  func testMetalReadsNativeHalfShadowOutputAsTheSameSceneValues() throws {
    let output = try nativeShadowOutput()
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    let width = output.count / 4
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba16Float, width: width, height: 1, mipmapped: false)
    descriptor.storageMode = .shared
    descriptor.usage = .shaderRead
    let texture = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
    output.withUnsafeBufferPointer { buffer in
      texture.replace(
        region: MTLRegionMake2D(0, 0, width, 1), mipmapLevel: 0,
        withBytes: buffer.baseAddress!, bytesPerRow: output.count * 2)
    }
    let source = """
      #include <metal_stdlib>
      using namespace metal;
      kernel void readShadows(texture2d<float, access::read> image [[texture(0)]],
                              device float4 *out [[buffer(0)]],
                              uint x [[thread_position_in_grid]]) {
        out[x] = image.read(uint2(x, 0));
      }
      """
    let library = try device.makeLibrary(source: source, options: nil)
    let function = try XCTUnwrap(library.makeFunction(name: "readShadows"))
    let pipeline = try device.makeComputePipelineState(function: function)
    let readback = try XCTUnwrap(
      device.makeBuffer(
        length: output.count * MemoryLayout<Float>.stride, options: .storageModeShared))
    let queue = try XCTUnwrap(device.makeCommandQueue())
    let command = try XCTUnwrap(queue.makeCommandBuffer())
    let encoder = try XCTUnwrap(command.makeComputeCommandEncoder())
    encoder.setComputePipelineState(pipeline)
    encoder.setTexture(texture, index: 0)
    encoder.setBuffer(readback, offset: 0, index: 0)
    encoder.dispatchThreads(
      MTLSize(width: width, height: 1, depth: 1),
      threadsPerThreadgroup: MTLSize(width: pipeline.threadExecutionWidth, height: 1, depth: 1))
    encoder.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    XCTAssertEqual(command.status, .completed)
    XCTAssertNil(command.error)
    let floats = readback.contents().bindMemory(to: Float.self, capacity: output.count)
    for index in output.indices {
      XCTAssertEqual(
        floats[index], Float(Float16(bitPattern: output[index])),
        "Metal decoded native half shadow lane \(index) differently from IEEE Float16")
    }
  }
}
