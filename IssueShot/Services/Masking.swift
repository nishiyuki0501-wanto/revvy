import Foundation

/// トークン・JWT・認証ヘッダー・URL 内認証情報・メールアドレスなど、よくある秘匿情報を伏せ字にする
enum Masking {
    private static let patterns: [(regex: NSRegularExpression, replacement: String)] = [
        // URL に埋め込まれた認証情報（https://user:pass@example.com）。メールより先に処理する
        (try! NSRegularExpression(pattern: #"([A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:)[^/\s@]+(@)"#), "$1[MASKED]$2"),
        // HTTP / JSON 形式の認証・秘匿ヘッダー
        (try! NSRegularExpression(pattern: #"("Authorization"\s*:\s*")(?:(?:\\.)|[^"\\\r\n])*"#, options: .caseInsensitive), "$1[MASKED]"),
        (try! NSRegularExpression(pattern: #"(?<!["\w-])(Authorization[ \t]*:[ \t]*)[^\r\n]+"#, options: .caseInsensitive), "$1[MASKED]"),
        (try! NSRegularExpression(pattern: #"("?(?:Set-)?Cookie"?\s*:\s*"?)[^\r\n"]+"#, options: .caseInsensitive), "$1[MASKED]"),
        (try! NSRegularExpression(pattern: #"("?X-(?:Share-Secret|Edit-Token|API-Key)"?\s*:\s*"?)[^"\s,}]+"#, options: .caseInsensitive), "$1[MASKED]"),
        // Revvy 共有リンクの編集用合言葉
        (try! NSRegularExpression(pattern: #"#edit=[A-Za-z0-9_-]{20,}"#), "#edit=[MASKED]"),
        // JWT / JWS / JWE（短いペイロードも含む）
        (try! NSRegularExpression(pattern: #"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){0,2}\b"#), "[MASKED_JWT]"),
        // GitHub（ghr_ リフレッシュトークンを含む）・Slack・AWS・汎用 API シークレットキー
        (try! NSRegularExpression(pattern: #"\b(gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|sk-(?:proj-|ant-|live_|test_)?[A-Za-z0-9_-]{20,})\b"#), "[MASKED_TOKEN]"),
        // メールアドレス
        (try! NSRegularExpression(pattern: #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#), "[MASKED_EMAIL]"),
    ]

    static func mask(_ text: String) -> String {
        patterns.reduce(text) { current, entry in
            entry.regex.stringByReplacingMatches(
                in: current,
                range: NSRange(current.startIndex..., in: current),
                withTemplate: entry.replacement
            )
        }
    }
}
