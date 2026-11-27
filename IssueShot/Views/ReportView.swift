import SwiftUI

/// Issue の入力は右のインスペクタへ。GitHub を使わない人はツールバーから畳める。
struct ReportInspector: View {
    @Environment(AppModel.self) private var model
    @Binding var showConnect: Bool

    var body: some View {
        @Bindable var model = model
        Form {
            if let capture = model.selectedCapture {
                Section("キャプチャ") {
                    TextField("あとで見つかる、ひとことメモ", text: Binding(
                        get: { model.selectedCapture?.note ?? "" },
                        set: { model.updateNote($0, for: capture.id) }
                    ), axis: .vertical)
                    .lineLimit(1...3)
                    if let image = model.screenshot {
                        LabeledContent("サイズ") {
                            Text("\(image.width) × \(image.height) px").monospaced().lineLimit(1)
                        }
                    }
                    if !capture.text.isEmpty {
                        Button("画像のテキストをコピー") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(capture.text, forType: .string)
                        }
                    }
                }
            }

            LinkShareSection()

            if model.user == nil {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("キャプチャを、チームへ。").font(.system(size: 13, weight: .semibold))
                        Text("GitHub をつなぐと、Issue を作成できます。")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button { showConnect = true } label: {
                            Label("GitHub と連携", systemImage: "link").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.auth == .checking)
                    }
                    .padding(.vertical, 2)
                }
            } else {
                Section("届け先") {
                    ShareDestinationPicker()
                    if let repo = model.selectedRepo {
                        Label(repo.isPrivate ? "アクセス権のあるメンバーだけが閲覧できます" : "公開リポジトリなので、誰でも閲覧できます",
                              systemImage: repo.isPrivate ? "lock" : "globe")
                            .font(.system(size: 10.5)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Section("Issue") {
                    TextField("タイトル", text: $model.title, prompt: Text("空欄なら本文から作成"))
                    TextField("本文", text: $model.comment,
                              prompt: Text("気づいたことや、改善したいことを書いてください。"),
                              axis: .vertical)
                        .lineLimit(4...12)
                    if model.screenshot != nil {
                        Label("編集中の画像を添付します", systemImage: "photo.badge.checkmark")
                            .font(.system(size: 10.5)).foregroundStyle(.secondary)
                    }
                }

                Section("担当とラベル") {
                    MultiSelectField(
                        title: String(localized: "担当者"),
                        empty: String(localized: "指定なし"),
                        countLabel: { String(localized: "\($0) 人") },
                        options: model.assignees.map { MultiSelectField.Option(id: $0.login, label: $0.login) },
                        selection: $model.selectedAssignees
                    )
                    MultiSelectField(
                        title: String(localized: "追加ラベル"),
                        empty: String(localized: "なし"),
                        countLabel: { String(localized: "\($0) 件") },
                        options: model.labels
                            .filter { $0.name != model.issueLabel }
                            .map { MultiSelectField.Option(id: $0.name, label: $0.name, dot: Color(gitHubHex: $0.color)) },
                        selection: $model.selectedLabels
                    )
                    LabeledContent("自動ラベル") {
                        Text(model.issueLabel).monospaced().lineLimit(1).truncationMode(.middle)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.user != nil { submitFooter }
        }
    }

    private var submitFooter: some View {
        VStack(spacing: 6) {
            Divider()
            Button { Task { await model.submit() } } label: {
                HStack(spacing: 7) {
                    if model.isSubmitting { ProgressView().controlSize(.small) }
                    else { Image(systemName: "paperplane") }
                    Text(model.isSubmitting ? (model.submitStatus ?? String(localized: "送信中…")) : String(localized: "Issue を作成"))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!model.canSubmit)
            .padding(.horizontal, 14)
            Text(model.screenshot == nil ? "本文のみで送信します" : "画像は \(model.assetsBranch) ブランチに保存されます")
                .font(.system(size: 10)).foregroundStyle(.secondary)
                .padding(.bottom, 12)
        }
        .background(.bar)
    }
}

/// GitHub なしで使えるリンク共有（Cloudflare の共有サーバー）。Gyazo のように、押すと URL がコピーされる。
struct LinkShareSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Section("リンクで共有") {
            Picker("保存期間", selection: $model.shareRetention) {
                ForEach(ShareRetention.allCases) { retention in
                    Text(retention.title).tag(retention)
                }
            }
            .pickerStyle(.segmented)
            Toggle("パスワードを付ける", isOn: $model.sharePasswordEnabled)
            if model.sharePasswordEnabled {
                SecureField("パスワード（8 文字以上）", text: $model.sharePassword)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("ランダムに作る") { model.sharePassword = ShareClient.generatePassword() }
                    Spacer()
                    Button("パスワードをコピー") {
                        SecretPasteboard.copy(model.sharePassword)
                    }
                    .disabled(!ShareClient.isValidPassword(model.sharePassword))
                }
                .buttonStyle(.link).font(.system(size: 11))
                if !model.sharePassword.isEmpty && !ShareClient.isValidPassword(model.sharePassword) {
                    Label("パスワードは 8〜128 文字で入力してください。", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 10.5)).foregroundStyle(.orange)
                }
                Text("パスワードを変えても、すでに作ったリンクのパスワードは変わりません。")
                    .font(.system(size: 10.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Label((model.sharePasswordEnabled
                   ? String(localized: "リンクとパスワードの両方を知っている人だけが見られます。")
                   : String(localized: "リンクを知っている人なら誰でも見られます。")) + model.shareRetention.expiryNotice,
                  systemImage: model.sharePasswordEnabled ? "lock" : "link")
                .font(.system(size: 10.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button { Task { await model.shareScreenshot() } } label: {
                HStack(spacing: 6) {
                    if model.isSharing { ProgressView().controlSize(.small) }
                    Text(model.isSharing ? "リンクを作成中…" : "リンクを作成してコピー")
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(model.screenshot == nil || model.isSharing
                      || (model.sharePasswordEnabled && !ShareClient.isValidPassword(model.sharePassword)))
            if let url = model.shareURL {
                HStack {
                    Link("共有画像を開く ↗", destination: url)
                    Spacer()
                    Button("再コピー") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(url.absoluteString, forType: .string)
                    }
                    .buttonStyle(.link)
                }
                .font(.system(size: 11))
                if let editURL = model.activeShares.first(where: { $0.url == url })?.editURL {
                    // 書き込みを保存できるのは、この編集用リンクを持っている人だけ
                    Link("ブラウザで編集 ↗", destination: editURL).font(.system(size: 11))
                }
                if let status = model.shareStatus {
                    Text(status).font(.system(size: 10.5)).foregroundStyle(.secondary)
                }
            } else if let status = model.shareStatus {
                Text(status).font(.system(size: 10.5)).foregroundStyle(.secondary)
            }
            if !model.activeShares.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("このキャプチャのリンク").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.secondary)
                    ForEach(model.activeShares) { share in
                        CloudShareRow(share: share)
                    }
                }
            }
        }
    }
}

private struct CloudShareRow: View {
    @Environment(AppModel.self) private var model
    let share: CloudShare
    @State private var confirmDelete = false

    private var expiryText: String {
        guard let expiresAt = share.expiresAt else { return String(localized: "無期限") }
        return String(localized: "\(expiresAt.formatted(date: .abbreviated, time: .omitted)) まで")
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: share.isProtected == true ? "lock" : share.expiresAt == nil ? "infinity" : "clock")
                .font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 14)
            VStack(alignment: .leading, spacing: 0) {
                Text(share.url.absoluteString).font(.system(size: 10.5, design: .monospaced))
                    .lineLimit(1).truncationMode(.middle)
                Text(expiryText).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if model.deletingShareIDs.contains(share.id) {
                ProgressView().controlSize(.mini)
            } else {
                Menu {
                    Button("リンクをコピー", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(share.url.absoluteString, forType: .string)
                    }
                    Link(destination: share.url) { Label("ブラウザで開く", systemImage: "arrow.up.right.square") }
                    if let editURL = share.editURL {
                        Divider()
                        Link(destination: editURL) { Label("ブラウザで編集", systemImage: "pencil.tip.crop.circle") }
                        Button("編集用リンクをコピー", systemImage: "pencil.and.list.clipboard") {
                            SecretPasteboard.copy(editURL.absoluteString)
                        }
                    }
                    Divider()
                    Button("リンクを削除…", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("リンクの操作")
            }
        }
        .confirmationDialog("このリンクを削除しますか？", isPresented: $confirmDelete) {
            Button("削除", role: .destructive) { Task { await model.deleteShare(share) } }
        } message: {
            Text("リンクを開いても、画像は表示されなくなります。この操作は取り消せません。")
        }
    }
}

/// 候補が多いので検索つきのポップオーバー。見た目は標準のボタンに揃える。
struct ShareDestinationPicker: View {
    @Environment(AppModel.self) private var model
    @State private var isPresented = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var filtered: [GHRepo] {
        model.repos.filter { query.isEmpty || $0.fullName.localizedStandardContains(query) }
    }

    var body: some View {
        Button { isPresented = true } label: {
            HStack(spacing: 6) {
                Image(systemName: model.selectedRepo?.isPrivate == true ? "lock.fill" : "globe")
                    .foregroundStyle(.secondary)
                Text(model.selectedRepo?.fullName ?? (model.isLoadingRepos ? String(localized: "読み込み中…") : String(localized: "選択してください")))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityLabel("共有先リポジトリ")
        .popover(isPresented: $isPresented) {
            VStack(alignment: .leading, spacing: 9) {
                TextField("リポジトリを検索", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                    .onSubmit { if let first = filtered.first { select(first) } }
                if model.isLoadingRepos {
                    ProgressView("読み込み中…").frame(maxWidth: .infinity).padding(.vertical, 20)
                } else if filtered.isEmpty {
                    Text(query.isEmpty ? "push 権限のあるリポジトリが見つかりません" : "「\(query)」に一致するものがありません")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("\(filtered.count) 件 · ⏎ で先頭を選択")
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                }
                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(filtered) { repo in
                            let isSelected = model.selectedRepo == repo
                            Button { select(repo) } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: repo.isPrivate ? "lock.fill" : "globe")
                                        .font(.system(size: 11))
                                        .foregroundStyle(isSelected ? RevvyStyle.accent : .secondary)
                                        .frame(width: 14)
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(repo.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                        Text(repo.owner.login).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer(minLength: 4)
                                    if isSelected {
                                        Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(RevvyStyle.accent)
                                    }
                                }
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(isSelected ? RevvyStyle.accent.opacity(0.12) : .clear,
                                            in: RoundedRectangle(cornerRadius: RevvyStyle.Radius.control))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(12)
            .frame(width: 320, height: 360)
            .onAppear { searchFocused = true }
        }
    }

    private func select(_ repo: GHRepo) {
        model.selectedRepo = repo
        query = ""
        isPresented = false
    }
}

/// 何を選んだかをチップで見せる複数選択。閉じたプルダウンの中に隠さない。
struct MultiSelectField: View {
    struct Option: Identifiable {
        let id: String
        let label: String
        var dot: Color?
    }

    let title: String
    /// 何も選んでいないときにプルダウンへ出す言葉。
    let empty: String
    /// 件数の表示（助数詞つき）。
    let countLabel: (Int) -> String
    let options: [Option]
    @Binding var selection: Set<String>

    private var chosen: [Option] {
        options.filter { selection.contains($0.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            LabeledContent(title) {
                Menu {
                    if options.isEmpty {
                        Text("候補がありません")
                    } else {
                        ForEach(options) { option in
                            Toggle(option.label, isOn: Binding(
                                get: { selection.contains(option.id) },
                                set: { on in
                                    if on { selection.insert(option.id) } else { selection.remove(option.id) }
                                }
                            ))
                        }
                        if !selection.isEmpty {
                            Divider()
                            Button("すべて解除") { selection.removeAll() }
                        }
                    }
                } label: {
                    Text(selection.isEmpty ? empty : countLabel(selection.count))
                        .foregroundStyle(selection.isEmpty ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(options.isEmpty)
            }
            if !chosen.isEmpty {
                FlowLayout {
                    ForEach(chosen) { option in
                        SelectionChip(label: option.label, dot: option.dot) { selection.remove(option.id) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: - 結果

struct ResultSheetItem: Identifiable, Equatable {
    let result: SubmitResult
    let warning: String?
    var id: Int { result.issue.number }
}

struct ResultSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: ResultSheetItem

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: item.warning == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 38))
                .foregroundStyle(item.warning == nil ? RevvyStyle.accent : .orange)
            Text("Issue #\(item.result.issue.number) を作成しました")
                .font(.system(size: 17, weight: .semibold))
            Text(item.result.issue.htmlUrl.absoluteString)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if let warning = item.warning {
                Text(warning)
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            HStack {
                Button("閉じる") { dismiss() }
                Button("新しいレポート") {
                    model.resetReport()
                    dismiss()
                }
                if GitHubURLValidator.isTrustedGitHubWebURL(item.result.issue.htmlUrl) {
                    Link(destination: item.result.issue.htmlUrl) {
                        Label("GitHub で開く", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(.top, 4)
        }
        .padding(28)
        .frame(width: 460)
    }
}
