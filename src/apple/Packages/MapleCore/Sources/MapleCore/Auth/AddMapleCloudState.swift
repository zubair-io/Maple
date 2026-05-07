// AddMapleCloudState.swift
//
// State enum for the AddMapleCloud flow. Every UI panel in the new sheet
// corresponds to exactly one of these cases. Transitions live in
// AddMapleCloudViewModel.

import Foundation

public indirect enum AddMapleCloudState: Equatable, Sendable {
  case idle
  case checkingBootstrap(CloudHost)
  case needsOwnerClaim(CloudHost)
  case registeringOwner(CloudHost, email: String)
  case needsAuth(CloudHost)
  case enteringSignInEmail(CloudHost)
  case signingIn(CloudHost, email: String)
  case enteringInviteDetails(CloudHost)
  case registeringInvitee(CloudHost, email: String, code: String)
  case signedIn(CloudHost, tokens: AuthTokens, user: AuthUser)
  case error(message: String, recoverableTo: AddMapleCloudState)

  public static func == (lhs: AddMapleCloudState, rhs: AddMapleCloudState) -> Bool {
    switch (lhs, rhs) {
    case (.idle, .idle): return true
    case (.checkingBootstrap(let a), .checkingBootstrap(let b)): return a == b
    case (.needsOwnerClaim(let a), .needsOwnerClaim(let b)): return a == b
    case (.registeringOwner(let a, let ea), .registeringOwner(let b, let eb)):
      return a == b && ea == eb
    case (.needsAuth(let a), .needsAuth(let b)): return a == b
    case (.enteringSignInEmail(let a), .enteringSignInEmail(let b)): return a == b
    case (.signingIn(let a, let ea), .signingIn(let b, let eb)):
      return a == b && ea == eb
    case (.enteringInviteDetails(let a), .enteringInviteDetails(let b)): return a == b
    case (.registeringInvitee(let a, let ea, let ca), .registeringInvitee(let b, let eb, let cb)):
      return a == b && ea == eb && ca == cb
    case (.signedIn(let a, let ta, let ua), .signedIn(let b, let tb, let ub)):
      return a == b && ta == tb && ua == ub
    case (.error(let ma, let ra), .error(let mb, let rb)):
      return ma == mb && ra == rb
    default: return false
    }
  }
}
