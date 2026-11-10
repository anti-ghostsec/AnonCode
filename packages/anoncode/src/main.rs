use std::io::Read;
use std::path::PathBuf;

use anoncode::projects::Projects;
use anoncode::supervisor::Config;
use anoncode::{focus, Error};

const HELP: &str = "anoncode: encrypted projects for the opencode agent

  anoncode                                open the AnonCode window
  anoncode list                           list projects
  anoncode focus                          FOCUS compression: JSON request on stdin, report on stdout
  anoncode help

The AnonCode folder is $ANONCODE_ROOT, or found from where this program is.
Everything it stores is under <folder>/.anoncode (or $ANONCODE_HOME).";

/// The folder holding `packages/cli`: `$ANONCODE_ROOT`, or the nearest
/// one above this program or the current folder.
fn root() -> Option<PathBuf> {
    if let Some(r) = std::env::var_os("ANONCODE_ROOT") {
        return Some(PathBuf::from(r));
    }
    let starts = [std::env::current_exe().ok(), std::env::current_dir().ok()];
    starts.into_iter().flatten().find_map(|start| start.ancestors().find(|d| d.join("packages/cli/src/index.ts").is_file()).map(PathBuf::from))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("anoncode: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn run(args: &[String]) -> Result<(), Error> {
    let command = args.first().map(String::as_str).filter(|a| !a.starts_with("--")).unwrap_or("gui");
    match command {
        "focus" => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            let request: focus::Request = serde_json::from_str(&input).map_err(|e| Error::Other(format!("bad request: {e}")))?;
            println!("{}", serde_json::to_string(&focus::compress(&request))?);
            Ok(())
        }
        "help" | "-h" => {
            println!("{HELP}");
            Ok(())
        }
        "list" | "gui" => {
            let root = root().ok_or_else(|| Error::Other("can't find the AnonCode folder; set ANONCODE_ROOT".into()))?;
            let base = std::env::var_os("ANONCODE_HOME").map(PathBuf::from).unwrap_or_else(|| root.join(".anoncode"));
            if command == "list" {
                for p in Projects::new(&base).list()? {
                    println!("{}\t{}\t{}", p.id, p.created_at, p.name);
                }
                return Ok(());
            }
            let server_command = std::env::var("ANONCODE_SERVER_COMMAND").map(|c| c.split_whitespace().map(String::from).collect()).unwrap_or_default();
            let cfg = Config { root, base, server_command };
            #[cfg(feature = "gui")]
            return anoncode::gui::run(cfg);
            #[cfg(not(feature = "gui"))]
            {
                let _ = cfg;
                Err(Error::Other("this build has no window (built without the gui feature)".into()))
            }
        }
        other => Err(Error::Other(format!("unknown command {other:?}\n\n{HELP}"))),
    }
}
