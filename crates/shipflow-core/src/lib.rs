pub mod bag;
pub mod manifest;
pub mod model;
pub mod parser;
pub mod runtime_log;
pub mod upstream;

#[macro_export]
macro_rules! shipflow_log {
    ($($argument:tt)*) => {
        $crate::runtime_log::write(format_args!($($argument)*))
    };
}
