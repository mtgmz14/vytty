//! A small, forgiving XML parser for configuration exports (SecureCRT,
//! mRemoteNG). No DTDs and no external entities: nothing is ever fetched or
//! expanded beyond the five predefined entities and numeric character
//! references. Tolerates a missing end tag.
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn attr_or_empty(&self, name: &str) -> &str {
        self.attr(name).unwrap_or("")
    }
    /// Local name without a namespace prefix ("mrng:Connections" -> "Connections").
    pub fn local_name(&self) -> &str {
        local_name(&self.name)
    }
}

pub fn local_name(n: &str) -> &str {
    n.rsplit(':').next().unwrap_or(n)
}

static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')"#).unwrap());
static TAG_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^\s/>]+)([\s\S]*)$").unwrap());

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    ENTITY
        .replace_all(s, |c: &regex::Captures| {
            let e = &c[1];
            if let Some(num) = e.strip_prefix('#') {
                let code = if let Some(h) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                    u32::from_str_radix(h, 16).ok()
                } else {
                    num.parse::<u32>().ok()
                };
                return code.and_then(char::from_u32).map(String::from).unwrap_or_else(|| c[0].to_string());
            }
            match e {
                "lt" => "<",
                "gt" => ">",
                "amp" => "&",
                "quot" => "\"",
                _ => "'",
            }
            .to_string()
        })
        .into_owned()
}

fn parse_attrs(src: &str) -> Vec<(String, String)> {
    ATTR.captures_iter(src)
        .map(|c| {
            let v = c.get(3).or_else(|| c.get(4)).map(|m| m.as_str()).unwrap_or("");
            (c[1].to_string(), decode_entities(v))
        })
        .collect()
}

fn find_from(src: &str, from: usize, pat: &str) -> Option<usize> {
    src.get(from..).and_then(|t| t.find(pat)).map(|i| i + from)
}

/// Parses `text` into a `#document` node.
pub fn parse_xml(text: &str) -> Node {
    let src = text.trim_start_matches('\u{feff}');
    let mut stack: Vec<Node> = vec![Node { name: "#document".into(), ..Default::default() }];
    let len = src.len();
    let mut i = 0usize;
    // Pops `stack` down to `depth` elements, attaching each popped node to its parent.
    fn close_to(stack: &mut Vec<Node>, depth: usize) {
        while stack.len() > depth {
            let node = stack.pop().unwrap();
            stack.last_mut().unwrap().children.push(node);
        }
    }
    while i < len {
        let Some(lt) = find_from(src, i, "<") else {
            stack.last_mut().unwrap().text.push_str(&decode_entities(&src[i..]));
            break;
        };
        if lt > i {
            stack.last_mut().unwrap().text.push_str(&decode_entities(&src[i..lt]));
        }
        let rest = &src[lt..];
        if rest.starts_with("<!--") {
            i = find_from(src, lt + 4, "-->").map(|e| e + 3).unwrap_or(len);
        } else if rest.starts_with("<![CDATA[") {
            let end = find_from(src, lt + 9, "]]>");
            stack.last_mut().unwrap().text.push_str(&src[lt + 9..end.unwrap_or(len)]);
            i = end.map(|e| e + 3).unwrap_or(len);
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            i = find_from(src, lt + 2, ">").map(|e| e + 1).unwrap_or(len);
        } else if rest.starts_with("</") {
            let end = find_from(src, lt + 2, ">");
            let name = src[lt + 2..end.unwrap_or(len)].trim();
            // Close up to the matching element (tolerates a missing end tag).
            if let Some(k) = (1..stack.len()).rev().find(|&k| stack[k].name == name) {
                close_to(&mut stack, k);
            }
            i = end.map(|e| e + 1).unwrap_or(len);
        } else {
            // The end of the tag, skipping '>' inside quoted attribute values.
            let bytes = src.as_bytes();
            let mut j = lt + 1;
            let mut quote: Option<u8> = None;
            while j < len {
                let c = bytes[j];
                match quote {
                    Some(q) if c == q => quote = None,
                    Some(_) => {}
                    None if c == b'"' || c == b'\'' => quote = Some(c),
                    None if c == b'>' => break,
                    None => {}
                }
                j += 1;
            }
            let body = &src[lt + 1..j.min(len)];
            let self_closing = body.ends_with('/');
            let inner = if self_closing { &body[..body.len() - 1] } else { body };
            if let Some(c) = TAG_NAME.captures(inner.trim()) {
                let node = Node { name: c[1].to_string(), attrs: parse_attrs(c.get(2).map(|m| m.as_str()).unwrap_or("")), ..Default::default() };
                if self_closing {
                    stack.last_mut().unwrap().children.push(node);
                } else {
                    stack.push(node);
                }
            }
            i = j + 1;
        }
    }
    close_to(&mut stack, 1);
    stack.pop().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_cdata_comments_quoting() {
        let doc = parse_xml(r#"<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='q"q'><b>t&lt;1&#65;&#x42;</b><c><![CDATA[<raw>]]></c><d/></a>"#);
        let a = &doc.children[0];
        assert_eq!(a.attr("x"), Some("1 & 2"));
        assert_eq!(a.attr("y"), Some("q\"q"));
        assert_eq!(a.children[0].text, "t<1AB");
        assert_eq!(a.children[1].text, "<raw>");
        assert_eq!(a.children[2].name, "d");
    }

    #[test]
    fn missing_end_tags_and_namespaces() {
        let doc = parse_xml("<mrng:Connections><Node Name=\"a\"><Node Name=\"b\"/></mrng:Connections>");
        let root = &doc.children[0];
        assert_eq!(root.local_name(), "Connections");
        assert_eq!(root.children[0].attr("Name"), Some("a"));
        assert_eq!(root.children[0].children[0].attr("Name"), Some("b"));
    }
}
