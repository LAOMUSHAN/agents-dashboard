#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 白屏看门狗重启本进程时带这个参数:等旧进程退出、单实例锁释放后再初始化
    if std::env::args().any(|a| a == "--relaunch-wait") {
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
    agents_dashboard_lib::run()
}
