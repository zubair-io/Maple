use super::CloudError;
use url::Url;

#[derive(Clone, Debug)]
pub struct Server(Url);
impl Server {
    pub fn parse(value: &str) -> Result<Self, CloudError> {
        let mut url = Url::parse(value.trim())
            .map_err(|_| CloudError::Protocol("Enter a complete Maple server URL".into()))?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(CloudError::Protocol(
                "Server URL cannot contain credentials, a query or a fragment".into(),
            ));
        }
        let local = match url.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
            Some(url::Host::Ipv6(ip)) => {
                ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
            }
            _ => false,
        };
        if url.scheme() != "https" && !(url.scheme() == "http" && local) {
            return Err(CloudError::Protocol(
                "Use HTTPS, or HTTP on localhost/a private LAN address".into(),
            ));
        }
        if !url.path().ends_with('/') {
            url.set_path(&format!("{}/", url.path()));
        }
        Ok(Self(url))
    }
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
    pub fn endpoint(&self, path: &str) -> Result<Url, CloudError> {
        if path.starts_with('/') || path.contains("..") {
            return Err(CloudError::Protocol("Invalid API path".into()));
        }
        self.0
            .join(path)
            .map_err(|e| CloudError::Protocol(e.to_string()))
    }
    pub fn address(&self, kind: &str, address: &str) -> Result<Url, CloudError> {
        if !["folder", "image", "thumb", "preview"].contains(&kind) {
            return Err(CloudError::Protocol("Invalid media endpoint".into()));
        }
        let (slug, path) = address
            .split_once(':')
            .ok_or_else(|| CloudError::Protocol("Missing library address".into()))?;
        if slug.is_empty() || slug.contains('/') || slug == "." || slug == ".." {
            return Err(CloudError::Protocol("Invalid library slug".into()));
        }
        let mut url = self.endpoint(&format!("api/{kind}"))?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| CloudError::Protocol("Invalid server URL".into()))?;
            segments.push(slug);
            for segment in path.split('/').filter(|part| !part.is_empty()) {
                if segment == "." || segment == ".." {
                    return Err(CloudError::Protocol("Invalid address path".into()));
                }
                segments.push(segment);
            }
        }
        Ok(url)
    }
    pub(super) fn xmp(&self, path: &str) -> Result<Url, CloudError> {
        let mut url = self.endpoint("api/xmp")?;
        // The existing path authorizer performs one extra percent decode after
        // query parsing. Escape literal percent signs to preserve exact names.
        url.query_pairs_mut()
            .append_pair("path", &path.replace('%', "%25"));
        Ok(url)
    }
    pub(super) fn sign_in(&self, challenge: &str, state: &str) -> Url {
        let mut url = self.0.clone();
        url.query_pairs_mut()
            .append_pair("native_callback", "maple-app")
            .append_pair("code_challenge", challenge)
            .append_pair("state", state);
        url
    }
}
