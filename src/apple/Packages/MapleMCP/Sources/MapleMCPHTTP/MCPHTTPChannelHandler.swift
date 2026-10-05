import Foundation
import MapleAgentWire
import NIOCore
import NIOHTTP1

final class MCPHTTPChannelHandler: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart

  private let token: String
  private let forward: MCPHTTPServer.Forward
  private var head: HTTPRequestHead?
  private var body = Data()
  private var responding = false
  private var sentResponse = false
  private var deadline: Scheduled<Void>?
  private var work: Task<Void, Never>?
  static let maxBodyBytes = 1024 * 1024

  init(token: String, forward: @escaping MCPHTTPServer.Forward) {
    self.token = token
    self.forward = forward
  }

  func channelActive(context: ChannelHandlerContext) {
    deadline = context.eventLoop.scheduleTask(in: .seconds(10)) { context.close(promise: nil) }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    guard !responding else { return }
    switch unwrapInboundIn(data) {
    case .head(let incoming):
      guard head == nil else { return respond(.badRequest, context: context) }
      head = incoming
      let port = context.channel.localAddress?.port ?? 0
      if let error = MCPHTTPProtocol.validateEndpoint(incoming, port: port, token: token) {
        respond(error, context: context)
      }
    case .body(var bytes):
      guard body.count + bytes.readableBytes <= Self.maxBodyBytes else {
        return respond(.init(status: .payloadTooLarge), context: context)
      }
      if let data = bytes.readBytes(length: bytes.readableBytes) { body.append(contentsOf: data) }
    case .end:
      guard let head else { return respond(.badRequest, context: context) }
      responding = true
      deadline?.cancel()
      // Full-resolution RAW export can take longer than an editor inspection.
      deadline = context.eventLoop.scheduleTask(in: .seconds(300)) { context.close(promise: nil) }
      let body = body
      let forward = forward
      let eventLoop = context.eventLoop
      let completion = NIOLoopBound((self, context), eventLoop: eventLoop)
      // Editor inspection awaits rendering; never block NIO or the UI.
      work = Task.detached {
        let response = await MCPHTTPProtocol.reply(head: head, body: body, forward: forward)
        guard !Task.isCancelled else { return }
        eventLoop.execute {
          let (handler, context) = completion.value
          handler.respond(response, context: context)
        }
      }
    }
  }

  func channelInactive(context: ChannelHandlerContext) {
    deadline?.cancel()
    work?.cancel()
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    respond(.badRequest, context: context)
  }

  private func respond(_ response: MCPHTTPResponse, context: ChannelHandlerContext) {
    guard !sentResponse, context.channel.isActive else { return }
    sentResponse = true
    responding = true
    deadline?.cancel()
    var headers = HTTPHeaders([
      ("Content-Length", String(response.body.count)), ("Connection", "close"),
      ("Cache-Control", "no-store"),
    ])
    if !response.body.isEmpty { headers.add(name: "Content-Type", value: "application/json") }
    if response.status == .methodNotAllowed { headers.add(name: "Allow", value: "POST") }
    if response.status == .unauthorized {
      headers.add(name: "WWW-Authenticate", value: "Bearer realm=\"Maple\"")
    }
    context.write(
      wrapOutboundOut(.head(.init(version: .http1_1, status: response.status, headers: headers))),
      promise: nil)
    if !response.body.isEmpty {
      var buffer = context.channel.allocator.buffer(capacity: response.body.count)
      buffer.writeBytes(response.body)
      context.write(wrapOutboundOut(.body(.byteBuffer(buffer))), promise: nil)
    }
    let finished = context.eventLoop.makePromise(of: Void.self)
    context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: finished)
    finished.futureResult.whenComplete { _ in context.close(promise: nil) }
  }
}
