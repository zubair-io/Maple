## Manual passkey QA

Run after any change to the auth code paths.

- [ ] Fresh server: claim with email + passkey on Mac, sign in on iPhone.
- [ ] Owner generates invite, second user joins from another machine.
- [ ] Member cannot reach `/settings/users` (web) / `ManageUsersView` (Apple).
- [ ] Removing one of two passkeys works; removing the last is blocked.
- [ ] Sign out, kill server, restart, sign in: refresh token still valid.
- [ ] Refresh-token reuse (manually replay an old refresh): subsequent refresh attempts fail; user is signed out.
