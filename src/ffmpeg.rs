use std::{
    process::{Command, Output},
    sync::{Condvar, Mutex},
};

static RUNNING: Mutex<usize> = Mutex::new(0);
static AVAILABLE: Condvar = Condvar::new();
const MAX_JOBS: usize = 2;

pub trait FfmpegOutput {
    fn limited_output(&mut self) -> std::io::Result<Output>;
}
impl FfmpegOutput for Command {
    fn limited_output(&mut self) -> std::io::Result<Output> {
        let mut count = AVAILABLE
            .wait_while(RUNNING.lock().unwrap(), |n| *n >= MAX_JOBS)
            .unwrap();
        *count += 1;
        drop(count);
        let result = self.output();
        *RUNNING.lock().unwrap() -= 1;
        AVAILABLE.notify_one();
        result
    }
}
