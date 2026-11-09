import SwiftUI

/// First screen: the server's address and an optional pairing code, or the demo. In the new look's
/// Night (default) or Day colours, whichever the page showed last.
struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var address = ""
    @State private var code = ""
    @FocusState private var focus: Field?
    private enum Field { case address, code }

    private var look: Look { model.look }
    private var first: Bool { model.server == nil || model.server == AppModel.demoServer }

    var body: some View {
        ZStack {
            LookBackground(look: look)
            ScrollView {
                card
                    .frame(maxWidth: 480)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear {
            if address.isEmpty, let s = model.server, s != AppModel.demoServer { address = s }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            FaceBadge(look: look)
            Text(first ? "Connect to your Sara" : "Add a Sara")
                .font(.system(size: 26, weight: .semibold))
                .tracking(-0.4)
                .foregroundStyle(look.text1)
            Text(first ? "Type the address you open Sara at in a web browser, for example sara.example.com or 192.168.1.20:7860." : "Type the address of another Sara. Your other Saras stay signed in.")
                .foregroundStyle(look.text2)
            label("Address")
            TextField("", text: $address, prompt: Text("Server address").foregroundStyle(look.text3))
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .focused($focus, equals: .address)
                .onSubmit { focus = .code }
                .modifier(FieldStyle(look: look, focused: focus == .address))
                .accessibilityIdentifier("address")
            label("Pairing code (optional)")
            TextField("", text: $code, prompt: Text("XXXX-XXXX-XXXX").foregroundStyle(look.text3))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.body.monospaced())
                .submitLabel(.go)
                .focused($focus, equals: .code)
                .onSubmit(connect)
                .modifier(FieldStyle(look: look, focused: focus == .code))
                .accessibilityIdentifier("code")
            Text("Get a code on a device where you're signed in: Settings → Connections → Devices and sign-in → Add a phone or computer. Without one, you sign in with your owner token.")
                .font(.footnote)
                .foregroundStyle(look.text2)
            if let e = model.setupError {
                Text(e).foregroundStyle(look.danger)
            }
            Button(action: connect) {
                if model.busy { ProgressView().tint(.white) } else { Text("Connect") }
            }
            .buttonStyle(MainButtonStyle(look: look))
            .disabled(model.busy)
            .padding(.top, 4)
            .accessibilityIdentifier("connect")

            Rectangle().fill(look.hairlineStrong).frame(height: 1).padding(.vertical, 8)
            Text("No server yet? The demo shows what Sara is like (conversations there aren't saved).")
                .font(.footnote)
                .foregroundStyle(look.text2)
            Button("Try the demo") { model.tryDemo() }
                .buttonStyle(QuietButtonStyle(look: look))
                .accessibilityIdentifier("demo")
            if model.server != nil {
                Button("Back to \(Servers.list().first { $0.url == model.server }?.name ?? "Sara")") { model.open(path: "/") }
                    .buttonStyle(QuietButtonStyle(look: look))
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 26)
        .padding(.bottom, 24)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(look.surface1))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(look.hairlineStrong, lineWidth: 1))
        .shadow(color: look.day ? Color(hex: 0x3C1E46, alpha: 0.12) : Color(hex: 0x9B6BFF, alpha: 0.12), radius: 30, y: 14)
    }

    private func label(_ s: String) -> some View {
        Text(s).font(.subheadline.weight(.medium)).foregroundStyle(look.text1).padding(.top, 4)
    }

    private func connect() {
        focus = nil
        Task { await model.connect(address: address, code: code) }
    }
}

/// The web's inputs: a sunken surface with a hairline edge, the accent edge while typing.
private struct FieldStyle: ViewModifier {
    let look: Look
    let focused: Bool

    func body(content: Content) -> some View {
        content
            .foregroundStyle(look.text1)
            .tint(look.accentText)
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(look.surface2))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(focused ? look.accentText : look.hairlineStrong, lineWidth: focused ? 2 : 1))
    }
}
