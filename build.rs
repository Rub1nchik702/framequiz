use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-changed=ui");
    let dict: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&fs::read_to_string("ui/en.json").unwrap()).unwrap();
    let mut words: Vec<_> = dict.iter().collect();
    words.sort_by_key(|(s, _)| std::cmp::Reverse(s.len()));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for file in ["index.html", "app.js", "music.js"] {
        let source = fs::read_to_string(format!("ui/{file}"))
            .unwrap()
            .replace("\r\n", "\n")
            .replace("@VERSION@", env!("CARGO_PKG_VERSION"));
        fs::write(out.join(file), &source).unwrap();
        let mut en = source;
        for (ru, translation) in &words {
            if file.ends_with(".js") {
                en = en.replace(
                    &serde_json::to_string(ru).unwrap(),
                    &serde_json::to_string(translation).unwrap(),
                );
            } else {
                en = en.replace(ru.as_str(), translation);
            }
        }
        if file.ends_with(".html") {
            en = en
                .replace("lang=\"ru\"", "lang=\"en\"")
                .replace("src=\"/music.js\"", "src=\"/en/music.js\"")
                .replace("src=\"/app.js\"", "src=\"/en/app.js\"");
        }
        if file == "app.js" {
            en = en.replace(
                "const errorMessages = {};",
                &format!(
                    "const errorMessages = {};",
                    fs::read_to_string("ui/errors.en.json").unwrap()
                ),
            );
        }
        fs::write(out.join(format!("en-{file}")), en).unwrap();
    }
}
