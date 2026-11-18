use crate::MetadataModel;
use serde::Serialize;
use std::sync::Arc;

/// One registered version of an application's metadata.
#[derive(Debug, Clone, Serialize)]
pub struct MetadataVersion {
    pub version: u32,
    pub fingerprint: String,
    pub model: Arc<MetadataModel>,
}

/// Versioned, append-only metadata registry. Versions are immutable once registered, so
/// executions can hold a snapshot (`Arc`) while newer versions are added.
#[derive(Debug, Default)]
pub struct MetadataRegistry {
    versions: Vec<MetadataVersion>,
}

impl MetadataRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a model; registering an identical model again returns the existing version.
    pub fn register(&mut self, model: MetadataModel) -> MetadataVersion {
        let fingerprint = model.fingerprint();
        if let Some(last) = self.versions.last() {
            if last.fingerprint == fingerprint {
                return last.clone();
            }
        }
        let v = MetadataVersion { version: self.versions.len() as u32 + 1, fingerprint, model: Arc::new(model) };
        self.versions.push(v.clone());
        v
    }

    pub fn current(&self) -> Option<&MetadataVersion> {
        self.versions.last()
    }

    pub fn get(&self, version: u32) -> Option<&MetadataVersion> {
        self.versions.get(version.checked_sub(1)? as usize)
    }

    pub fn len(&self) -> usize {
        self.versions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.versions.is_empty()
    }
}
