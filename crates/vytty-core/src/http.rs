//! The HTTP client for updates and NetBox: TLS checked by the operating
//! system's verifier (so company root certificates and TLS inspection
//! proxies work like in the browser) and the system proxy settings.
use std::sync::OnceLock;
use std::time::Duration;

pub fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .user_agent(format!("Vytty/{}", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(20))
                .tls_backend_rustls()
                .build()
                .expect("HTTP client")
        })
        .clone()
}
