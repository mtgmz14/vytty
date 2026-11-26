//! Session import from other tools. Each parser returns
//!   { folders, sessions, stats: { total, imported, byType, skipped }, secrets? }
//! where sessions/folders carry their own ids (the UI gives them fresh ones
//! when merging) and secrets maps a session id to { password } for formats
//! that contain passwords (mRemoteNG).
pub mod common;
pub mod csv;
pub mod mobaxterm;
pub mod mremoteng;
pub mod putty;
pub mod securecrt;
pub mod sshconfig;
pub mod xml;

use crate::util::Obj;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

pub struct Format {
    pub id: &'static str,
    pub label: &'static str,
    /// The source is a folder, not a file.
    pub directory: bool,
    /// File dialog filter: name and extensions ("*" for any).
    pub filter: (&'static str, &'static [&'static str]),
}

pub const FORMATS: &[Format] = &[
    Format { id: "mobaxterm", label: "MobaXterm", directory: false, filter: ("MobaXterm sessions", &["mxtsessions", "mobaxterm", "moba", "ini", "txt"]) },
    Format { id: "putty", label: "PuTTY / KiTTY", directory: false, filter: ("Registry export", &["reg"]) },
    Format { id: "securecrt", label: "SecureCRT", directory: false, filter: ("SecureCRT XML export", &["xml"]) },
    Format { id: "securecrt-dir", label: "SecureCRT (session folder)", directory: true, filter: ("", &[]) },
    Format { id: "mremoteng", label: "mRemoteNG", directory: false, filter: ("mRemoteNG connections", &["xml"]) },
    Format { id: "sshconfig", label: "OpenSSH config", directory: false, filter: ("SSH config", &["*"]) },
    Format { id: "csv", label: "CSV", directory: false, filter: ("CSV", &["csv", "txt", "tsv"]) },
];

pub fn format(id: &str) -> Option<&'static Format> {
    FORMATS.iter().find(|f| f.id == id)
}

/// Where the file usually is, for the open dialog.
pub fn default_path(id: &str) -> Option<PathBuf> {
    match id {
        "sshconfig" => Some(sshconfig::default_path()),
        _ => None,
    }
}

/// Parses file contents (or, for folder formats, reads the folder).
pub fn parse_import(format: &str, data: &[u8], password: Option<&str>) -> Result<Obj> {
    match format {
        "mobaxterm" => mobaxterm::parse(data),
        "putty" => putty::parse(data),
        "securecrt" => securecrt::parse_xml_export(data),
        "mremoteng" => mremoteng::parse(data, password),
        "sshconfig" => sshconfig::parse(data),
        "csv" => csv::parse(data),
        _ => bail!("Unknown import format {format}"),
    }
}

pub fn parse_import_dir(format: &str, dir: &Path) -> Result<Obj> {
    match format {
        "securecrt-dir" => securecrt::parse_session_dir(dir),
        _ => bail!("Unknown import format {format}"),
    }
}
