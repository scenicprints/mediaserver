import SwiftUI

// Sign in. The whole screen is one panel with the wordmark over it — the front
// of the machine before you switch it on.
struct LoginView: View {
    @EnvironmentObject var store: Store
    @Environment(\.pal) private var pal
    @State private var username = ""
    @State private var password = ""
    @State private var code = ""
    @State private var registering = false

    var body: some View {
        ZStack {
            pal.paper.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                MarqueeWordmark()
                Lab(registering ? "Create your account" : "Sign in to continue", small: true)
                    .padding(.top, 16)

                MField(prompt: "Username", text: $username).padding(.top, 40)
                MField(prompt: "Password", text: $password, secure: true).padding(.top, 18)
                if registering {
                    MField(prompt: "Invite code", text: $code).padding(.top, 18)
                }

                if let e = store.error {
                    Text(e).font(F.med(18)).foregroundStyle(pal.signal).padding(.top, 18)
                }

                MButton(title: store.loading ? "Working" : (registering ? "Create account" : "Sign in"),
                        kind: .primary, wide: true, height: 72) {
                    Task {
                        if registering {
                            await store.register(username: username, password: password, code: code)
                        } else {
                            await store.login(username: username, password: password)
                        }
                    }
                }
                .padding(.top, 30)
                .disabled(store.loading || username.isEmpty || password.isEmpty)

                MButton(title: registering ? "I have an account" : "Create an account", wide: true) {
                    registering.toggle()
                    store.error = nil
                }
                .padding(.top, 12)
            }
            .frame(width: 660)
            .padding(56)
            .background(pal.panel)
            .overlay(Rectangle().strokeBorder(pal.rule, lineWidth: 1))
        }
    }
}

// A text field the system keyboard fills in. Label above, ink rule below —
// nothing is boxed.
struct MField: View {
    let prompt: String
    @Binding var text: String
    var secure = false
    @Environment(\.pal) private var pal
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Lab(prompt, small: true)
            Group {
                if secure {
                    SecureField("", text: $text)
                } else {
                    TextField("", text: $text).textInputAutocapitalization(.never)
                }
            }
            .textFieldStyle(.plain)
            .font(F.med(26))
            .foregroundStyle(pal.ink)
            .focused($focused)
            .padding(.vertical, 10)
            .overlay(alignment: .bottom) {
                Rectangle().fill(focused ? pal.signal : pal.rule).frame(height: focused ? 3 : 2)
            }
        }
    }
}
