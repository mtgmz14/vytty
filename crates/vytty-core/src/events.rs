//! Messages to the window, and questions the backend asks the user (host
//! key confirmation, passwords) while it waits for the answer.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Event {
    Data { id: String, data: String },
    Status { id: String, state: String, message: String },
    Closed { id: String, reason: String },
    SftpProgress { id: String, p: Value },
    SftpError { message: String },
    DragResult { r: Value },
    UpdateProgress { got: u64, total: u64, phase: String },
    #[serde(rename_all = "camelCase")]
    Prompt { req_id: u64, kind: String, payload: Value },
    OpenUrl { list: Value },
    CloseRequest,
    WinState { maximized: bool },
    /// Files dropped on the window (Linux / macOS), in CSS pixels.
    FileDrop { paths: Vec<String>, x: f64, y: f64 },
    /// Paths of dropped File objects, asked for by the page (Windows).
    FilePaths { req: String, paths: Vec<String> },
    /// Test builds only: lines for the end-to-end runner.
    E2e { value: Value },
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Ui {
    emit: Emit,
    seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl Ui {
    pub fn new(emit: Emit) -> Arc<Self> {
        Arc::new(Ui { emit, seq: AtomicU64::new(0), pending: Mutex::new(HashMap::new()) })
    }

    pub fn emit(&self, ev: Event) {
        (self.emit)(ev)
    }

    /// Asks the window and waits for the answer; `None` when the user cancelled
    /// (or the window went away).
    pub async fn ask(&self, kind: &str, payload: Value) -> Option<Value> {
        let req_id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(req_id, tx);
        self.emit(Event::Prompt { req_id, kind: kind.to_string(), payload });
        match rx.await {
            Ok(Value::Null) | Ok(Value::Bool(false)) | Err(_) => None,
            Ok(v) => Some(v),
        }
    }

    pub fn reply(&self, req_id: u64, answer: Value) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&req_id) {
            let _ = tx.send(answer);
        }
    }

    /// The page was reloaded: nobody will answer the open questions.
    pub fn cancel_all(&self) {
        self.pending.lock().unwrap().clear();
    }
}
