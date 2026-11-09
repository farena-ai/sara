// Sara for iPhone (Phase 17): the web app in a native shell, like the Android app, plus Apple
// notifications, the Home Screen / Lock Screen widget, sign-in with a pairing code, and the demo.
import SwiftUI

@main
struct SaraApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onOpenURL { model.handle(url: $0) }
                // The status bar follows what's under it: the page's top edge (the call screen
                // stays dark in Day too), or the app's own screens in Night / Day. Set on the root
                // view controller, not the window: the web view keeps the phone's own light/dark
                // setting (SaraWebView), so the page's "Follow the system" theme still works.
                .onChange(of: model.statusDark, initial: true) { _, _ in model.applyStatusStyle() }
                .onAppear { DispatchQueue.main.async { model.applyStatusStyle() } }
        }
    }
}

/// The new look's colours (web/theme.css, docs/design/NEW_LOOK.md) for the app's own screens:
/// Night (the default) and Day, whichever the page showed last.
struct Look: Equatable {
    let day: Bool

    static let night = Look(day: false)
    static let dayLook = Look(day: true)

    var bg: Color { day ? Color(hex: 0xFAF7F5) : Color(hex: 0x0F0D17) }
    var surface1: Color { day ? Color(hex: 0xFFFFFF) : Color(hex: 0x17141F) }
    var surface2: Color { day ? Color(hex: 0xF4EEF1) : Color(hex: 0x1E1A29) }
    var hairlineStrong: Color { day ? Color(hex: 0x2E1636, alpha: 0.16) : Color(hex: 0xFFFFFF, alpha: 0.14) }
    var text1: Color { day ? Color(hex: 0x221A2A) : Color(hex: 0xF1EDF7) }
    var text2: Color { day ? Color(hex: 0x5E5469) : Color(hex: 0xAEA6BD) }
    var text3: Color { day ? Color(hex: 0x736A7E) : Color(hex: 0x8E86A0) }
    var accentText: Color { day ? Color(hex: 0xB8436A) : Color(hex: 0xF08AA5) }
    var danger: Color { day ? Color(hex: 0xC0303A) : Color(hex: 0xFF6B7D) }
    /// Main buttons: the web's deep rose → violet (white text at 5:1+).
    var button: LinearGradient {
        LinearGradient(colors: day ? [Color(hex: 0xB8436A), Color(hex: 0x7A50D2)] : [Color(hex: 0xA8456D), Color(hex: 0x6D48C4)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    /// The ring around her picture.
    var ring: LinearGradient { LinearGradient(colors: [Color(hex: 0xE0607E), Color(hex: 0x9B6BFF)], startPoint: .topLeading, endPoint: .bottomTrailing) }
    var glowViolet: Color { Color(hex: 0x9B6BFF, alpha: day ? 0.07 : 0.15) }
    var glowRose: Color { Color(hex: 0xE0607E, alpha: day ? 0.06 : 0.11) }
    var uiBg: UIColor { day ? UIColor(hex: 0xFAF7F5) : UIColor(hex: 0x0F0D17) }

    /// The theme the page showed last on this phone (Night until it says otherwise).
    static var saved: Look { UserDefaults.standard.string(forKey: "look") == "day" ? .dayLook : .night }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// "#rrggbb" from the page, or nil.
    convenience init?(page: String) {
        guard page.count == 7, page.hasPrefix("#"), let v = UInt32(page.dropFirst(), radix: 16) else { return nil }
        self.init(hex: v)
    }

    /// True for colours dark text and icons should sit on (WCAG relative luminance).
    var isLight: Bool {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        func lin(_ c: CGFloat) -> CGFloat { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.179
    }
}

/// The app's own screens' background: the surface with the web's soft glows (--page-glow).
struct LookBackground: View {
    let look: Look

    var body: some View {
        ZStack {
            look.bg
            RadialGradient(colors: [look.glowViolet, .clear], center: UnitPoint(x: 0.75, y: 0), startRadius: 0, endRadius: 520)
            RadialGradient(colors: [look.glowRose, .clear], center: UnitPoint(x: 0, y: 1), startRadius: 0, endRadius: 440)
        }
        .ignoresSafeArea()
    }
}

/// Her picture in the accent ring, with "AI companion" beside it (as on Today).
struct FaceBadge: View {
    let look: Look

    var body: some View {
        HStack(spacing: 14) {
            Image("Face")
                .resizable()
                .scaledToFill()
                .frame(width: 64, height: 64)
                .clipShape(Circle())
                .padding(3)
                .background(Circle().fill(look.surface1))
                .padding(2)
                .background(Circle().fill(look.ring))
                .shadow(color: Color(hex: 0xE0607E, alpha: look.day ? 0.25 : 0.35), radius: 12, y: 4)
                .accessibilityLabel("Sara")
            Text("AI companion")
                .font(.footnote)
                .foregroundStyle(look.text2)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(look.surface2))
                .overlay(Capsule().stroke(look.hairlineStrong, lineWidth: 1))
        }
        .padding(.bottom, 6)
    }
}

/// The main button: the rose → violet gradient with white text.
struct MainButtonStyle: ButtonStyle {
    let look: Look

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(look.button))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// A quiet button: the raised surface with a hairline edge.
struct QuietButtonStyle: ButtonStyle {
    let look: Look

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(look.text1)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(look.surface2))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(look.hairlineStrong, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ZStack {
            model.look.bg.ignoresSafeArea()
            if model.screen == .web, model.server != nil {
                // Phase 68: a new web view (on that server's own data store) for each server.
                // The page draws under the status bar and the home indicator itself
                // (env(safe-area-inset-*) with viewport-fit=cover); the keyboard still resizes it.
                WebView(model: model).id(model.activeId)
                    .ignoresSafeArea(.container, edges: .all)
            } else {
                SetupView()
            }
            if model.locked || model.covered {
                LockView(locked: model.locked, look: model.look) { model.unlock() }
            }
        }
        .onChange(of: phase) { _, p in model.scene(p) }
        .alert(pairTitle, isPresented: pairShown, presenting: model.pairLink) { link in
            if link.refused {
                Button("OK", role: .cancel) {}
            } else if switching(link) {
                // Adding a server from a link is the careful choice; Cancel is the default.
                Button("Add", role: .destructive) { Task { await model.accept(link) } }
                Button("Cancel", role: .cancel) {}
            } else {
                // Without a code: open that server's sign-in page (code or owner token there).
                Button("Sign in") { Task { await model.accept(link) } }
                Button("Cancel", role: .cancel) {}
            }
        } message: { link in
            Text(pairMessage(link))
        }
        .alert("Couldn't switch", isPresented: switchErrorShown) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.switchError ?? "")
        }
    }
}

extension RootView {
    private var pairShown: Binding<Bool> {
        Binding(get: { model.pairLink != nil }, set: { if !$0 { model.pairLink = nil } })
    }

    private var switchErrorShown: Binding<Bool> {
        Binding(get: { model.switchError != nil }, set: { if !$0 { model.switchError = nil } })
    }

    /// A server that isn't saved yet (Phase 68: it's added next to the others).
    private func switching(_ link: AppModel.PairLink) -> Bool {
        model.server != nil && model.server != link.server && !Servers.list().contains { $0.url == link.server }
    }

    private var pairTitle: String {
        guard let link = model.pairLink else { return "" }
        if link.refused { return "This link can't be used" }
        if switching(link) { return "Add this Sara?" }
        return link.code != nil ? "Sign in with a code" : "Open your Sara"
    }

    private func pairMessage(_ link: AppModel.PairLink) -> String {
        if link.refused {
            return "The pairing link doesn't hold a plain server address, so the app won't open it. Make a new code in Sara on your computer: Settings → Connections → Devices and sign-in → Add a phone or computer."
        }
        var m = switching(link)
            ? "Add \(link.server) to this app? Your other Saras stay signed in; switch between them from the ⇄ button at the top."
            : "Sign in to \(link.server)?"
        if link.server.hasPrefix("http://") && !AppModel.isPrivateHost(link.server) {
            m += "\n\n⚠ This address uses plain http on the open internet: anyone on the way could read your messages. Only continue if you set it up that way."
        }
        if switching(link) { m += "\n\nOnly add it if you made this link yourself." }
        return m
    }
}

/// Shown while the app lock is on and the app is locked (or in the app switcher).
struct LockView: View {
    let locked: Bool
    let look: Look
    let unlock: () -> Void

    var body: some View {
        ZStack {
            LookBackground(look: look)
            VStack(spacing: 16) {
                Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(look.text1)
                if locked {
                    Text("Locked").font(.title2.weight(.semibold)).foregroundStyle(look.text1)
                    Button("Unlock", action: unlock).buttonStyle(MainButtonStyle(look: look)).frame(width: 200)
                }
            }
        }
    }
}
