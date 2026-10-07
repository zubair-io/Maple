use super::{json, CloudClient, CloudError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};

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

impl CloudClient {
    pub fn begin_sign_in(&self) -> Result<(PendingSignIn, String), CloudError> {
        let pending = PendingSignIn::new()?;
        let url = self
            .server
            .sign_in(&pending.challenge(), &pending.state)
            .to_string();
        Ok((pending, url))
    }
    pub fn claim(&mut self, pending: &PendingSignIn) -> Result<bool, CloudError> {
        let response = self
            .http
            .post(self.server.endpoint("api/auth/native-code/claim")?)
            .json(&serde_json::json!({"state": pending.state, "code_verifier": pending.verifier}))
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
        self.install(tokens)?;
        Ok(true)
    }
    pub fn restore(&mut self) -> Result<bool, CloudError> {
        match self.credential.get_password() {
            Ok(refresh) => {
                self.refresh = Some(refresh);
                self.refresh_session()?;
                Ok(true)
            }
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    pub(super) fn refresh_session(&mut self) -> Result<(), CloudError> {
        let refresh = self.refresh.as_ref().ok_or(CloudError::Http(401))?;
        let response = self
            .http
            .post(self.server.endpoint("api/auth/refresh")?)
            .json(&serde_json::json!({"refresh_token": refresh}))
            .send()?;
        if [400, 401].contains(&response.status().as_u16()) {
            self.access = None;
            self.refresh = None;
            match self.credential.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) => return Err(error.into()),
            }
            return Err(CloudError::Http(response.status().as_u16()));
        }
        let tokens: Tokens = json(response)?;
        self.install(tokens)
    }
    fn install(&mut self, tokens: Tokens) -> Result<(), CloudError> {
        if tokens.access_token.is_empty() {
            return Err(CloudError::Protocol(
                "Server returned an empty access token".into(),
            ));
        }
        if let Some(refresh) = tokens.refresh_token.filter(|token| !token.is_empty()) {
            self.refresh = Some(refresh.clone());
            self.credential.set_password(&refresh)?;
        }
        self.access = Some(tokens.access_token);
        Ok(())
    }
    pub fn disconnect(&mut self) -> Result<(), CloudError> {
        self.access = None;
        self.refresh = None;
        match self.credential.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
