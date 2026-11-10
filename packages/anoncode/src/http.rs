//! The one HTTP request the manager makes: asking an agent server on the
//! loopback interface whether it is up.

use std::io::{self, BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// The status of `GET path` on a loopback port, with basic auth.
pub fn get_status(port: u16, path: &str, basic: &str) -> io::Result<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    write!(stream, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nauthorization: Basic {basic}\r\nconnection: close\r\n\r\n")?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad response"))
}
