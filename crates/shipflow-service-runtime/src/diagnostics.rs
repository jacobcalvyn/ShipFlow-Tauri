#[cfg(target_os = "macos")]
pub fn process_rss_bytes() -> Option<u64> {
    let mut task_info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_taskinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            task_info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }

    Some(unsafe { task_info.assume_init() }.pti_resident_size)
}

#[cfg(target_os = "linux")]
pub fn process_rss_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let resident_pages = statm.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return None;
    }

    resident_pages.checked_mul(page_size as u64)
}

#[cfg(target_os = "windows")]
pub fn process_rss_bytes() -> Option<u64> {
    use windows_sys::Win32::System::{
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };

    let mut counters = std::mem::MaybeUninit::<PROCESS_MEMORY_COUNTERS>::zeroed();
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>();
    let succeeded =
        unsafe { GetProcessMemoryInfo(GetCurrentProcess(), counters.as_mut_ptr(), size as u32) };
    if succeeded == 0 {
        return None;
    }

    Some(unsafe { counters.assume_init() }.WorkingSetSize as u64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn process_rss_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::process_rss_bytes;

    #[test]
    fn current_process_reports_nonzero_rss_on_supported_platforms() {
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        assert!(process_rss_bytes().is_some_and(|bytes| bytes > 0));
    }
}
