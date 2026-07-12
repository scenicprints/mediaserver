import SwiftUI

struct LoginView: View {
    @EnvironmentObject var store: Store
    @State private var username = ""
    @State private var password = ""
    @State private var code = ""
    @State private var registering = false

    var body: some View {
        VStack(spacing: 18) {
            Text("MARQUEE")
                .font(.system(size: 64, weight: .heavy))
                .foregroundStyle(
                    LinearGradient(colors: [Color(hex: 0x6c5cff), Color(hex: 0x37c2ff)],
                                   startPoint: .leading, endPoint: .trailing)
                )
            Text(registering ? "Create your account" : "Sign in to continue")
                .foregroundStyle(.secondary)

            TextField("Username", text: $username)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
            SecureField("Password", text: $password)
            if registering {
                TextField("Invite code", text: $code)
                    .textInputAutocapitalization(.never)
            }

            if let e = store.error {
                Text(e).foregroundStyle(.red).font(.callout)
            }

            Button(store.loading ? "…" : (registering ? "Create account" : "Sign in")) {
                Task {
                    if registering {
                        await store.register(username: username, password: password, code: code)
                    } else {
                        await store.login(username: username, password: password)
                    }
                }
            }
            .disabled(store.loading || username.isEmpty || password.isEmpty)

            Button(registering ? "Have an account? Sign in" : "New here? Create an account") {
                registering.toggle()
                store.error = nil
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .frame(width: 640)
        .padding(60)
    }
}
