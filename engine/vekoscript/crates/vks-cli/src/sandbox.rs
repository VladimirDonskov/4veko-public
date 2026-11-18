//! Operating-system limits the worker applies to itself before reading any request. They back
//! up the interpreter's own limits: if the engine had a bug that allocated without bound, the
//! operating system stops the process instead of the machine.
//!
//! - Windows: a Job Object with a per-process memory limit and a limit of one active process
//!   (the worker cannot start children).
//! - Linux: RLIMIT_AS (address space) and RLIMIT_NPROC is left to the service account.
//! - Elsewhere: none (reported on stderr).
//!
//! Wall-clock time is enforced by the Java host, which kills a worker that does not answer.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0000_0008;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
    const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;

    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
    }

    pub fn apply(max_memory_bytes: usize) -> Result<String, String> {
        // SAFETY: plain Win32 calls with a correctly sized, initialized structure. The job handle
        // is intentionally kept open for the life of the process.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err("CreateJobObjectW failed".into());
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            info.basic.active_process_limit = 1;
            info.process_memory_limit = max_memory_bytes;
            let ok = SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, &mut info as *mut _ as *mut c_void, std::mem::size_of::<ExtendedLimitInformation>() as u32);
            if ok == 0 {
                return Err("SetInformationJobObject failed".into());
            }
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                return Err("AssignProcessToJobObject failed (the parent may already use a job that forbids nesting)".into());
            }
        }
        Ok(format!("job object: memory {} MiB, 1 process", max_memory_bytes / (1024 * 1024)))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    #[repr(C)]
    struct RLimit {
        cur: u64,
        max: u64,
    }

    const RLIMIT_AS: i32 = 9;

    extern "C" {
        fn setrlimit(resource: i32, limit: *const RLimit) -> i32;
    }

    pub fn apply(max_memory_bytes: usize) -> Result<String, String> {
        let limit = RLimit { cur: max_memory_bytes as u64, max: max_memory_bytes as u64 };
        // SAFETY: setrlimit reads a valid, initialized struct.
        if unsafe { setrlimit(RLIMIT_AS, &limit) } != 0 {
            return Err("setrlimit(RLIMIT_AS) failed".into());
        }
        Ok(format!("rlimit: address space {} MiB", max_memory_bytes / (1024 * 1024)))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub fn apply(_max_memory_bytes: usize) -> Result<String, String> {
        Err("no operating-system limits on this platform".into())
    }
}

pub use imp::apply;
