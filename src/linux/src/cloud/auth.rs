use super::{json, CloudClient, CloudError, Server};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{blocking::Client, StatusCode};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub struct PendingSignIn {
    verifier: String,
    state: String,
}
impl PendingSignIn {
    pub fn new() -> Result<Self, CloudError> {
        let mut verifier = [0; 48];
        let mut state = [0; 24];
        getrandom::fill(&mut verifier)
            .map_err(|_| CloudError::Protocol("Secure random generator unavailable".into()))?;
        getrandom::fill(&mut state)
            .map_err(|_| CloudError::Protocol("Secure random generator unavailable".into()))?;
        Ok(Self {
            verifier: URL_SAFE_NO_PAD.encode(verifier),
            state: URL_SAFE_NO_PAD.encode(state),
        })
    }
    fn challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()))
    }
}

#[derive(serde::Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    state: Option<String>,
}

/// The session's tokens, shared by the client and every tile fetcher; the one lock serializes refreshes and keyring writes.
pub(super) struct Credentials(Mutex<Session>);

struct Session {
    entry: Arc<keyring::Entry>,
    access: Option<String>,
    refresh: Option<String>,
    retired: bool,
}

impl Session {
    fn install(&mut self, tokens: Tokens) -> Result<(), CloudError> {
        if tokens.access_token.is_empty() {
            return Err(CloudError::Protocol(
                "Server returned an empty access token".into(),
            ));
        }
        if let Some(token) = tokens.refresh_token.filter(|token| !token.is_empty()) {
            self.refresh = Some(token.clone());
            self.entry.set_password(&token)?;
        }
        self.access = Some(tokens.access_token);
        Ok(())
    }

    fn forget(&mut self) -> Result<(), CloudError> {
        self.access = None;
        self.refresh = None;
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn rotate(&mut self, http: &Client, server: &Server) -> Result<(), CloudError> {
        let token = self.refresh.clone().ok_or(CloudError::Http(401))?;
        let response = http
            .post(server.endpoint("api/auth/refresh")?)
            .json(&serde_json::json!({"refresh_token": token}))
            .send()?;
        if [400, 401].contains(&response.status().as_u16()) {
            self.forget()?;
            return Err(CloudError::Http(response.status().as_u16()));
        }
        self.install(json(response)?)
    }
}

impl Credentials {
    pub(super) fn new(entry: Arc<keyring::Entry>) -> Self {
        Self(Mutex::new(Session {
            entry,
            access: None,
            refresh: None,
            retired: false,
        }))
    }

    fn session(&self) -> MutexGuard<'_, Session> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn access(&self) -> Option<String> {
        self.session().access.clone()
    }

    /// `failed_with` is the token the rejected request carried, if any; a token since replaced was already refreshed.
    pub(super) fn refresh(
        &self,
        http: &Client,
        server: &Server,
        failed_with: Option<&str>,
    ) -> Result<(), CloudError> {
        let mut session = self.session();
        if session.retired {
            return Err(CloudError::Http(401));
        }
        if session.access.as_deref() != failed_with {
            return Ok(());
        }
        session.rotate(http, server)
    }

    pub(super) fn restore(&self, http: &Client, server: &Server) -> Result<bool, CloudError> {
        let mut session = self.session();
        match session.entry.get_password() {
            Ok(token) => {
                session.refresh = Some(token);
                session.rotate(http, server)?;
                Ok(true)
            }
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// The keyring entry now belongs to the session that replaced this one, so a retired one never writes it.
    pub(super) fn retire(&self) {
        self.session().retired = true;
    }
}

impl CloudClient {
    pub fn begin_sign_in(&self) -> Result<(PendingSignIn, String), CloudError> {
        let pending = PendingSignIn::new()?;
        let url = self
            .server
            .sign_in(&pending.challenge(), &pending.state)
            .to_string();
        Ok((pending, url))
    }
    pub fn claim(&mut self, pending: &PendingSignIn, code: &str) -> Result<bool, CloudError> {
        if !(16..=128).contains(&code.len())
            || !code
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(CloudError::Protocol(
                "Copy the sign-in code from your browser".into(),
            ));
        }
        let response = self
            .http
            .post(self.server.endpoint("api/auth/native-code/claim")?)
            .json(&serde_json::json!({"state": pending.state, "code_verifier": pending.verifier, "code": code}))
            .send()?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND
            || status == StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
        {
            return Ok(false);
        }
        let tokens: Tokens = json(response)?;
        if tokens.state.as_deref() != Some(&pending.state) {
            return Err(CloudError::Protocol(
                "Sign-in state did not match this browser ceremony".into(),
            ));
        }
        self.credentials.session().install(tokens)?;
        Ok(true)
    }
    pub fn restore(&mut self) -> Result<bool, CloudError> {
        self.credentials.restore(&self.http, &self.server)
    }
    pub fn disconnect(&mut self) -> Result<(), CloudError> {
        self.credentials.session().forget()
    }
    pub(super) fn retire(&self) {
        self.credentials.retire();
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
