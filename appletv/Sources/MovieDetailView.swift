import SwiftUI

// A cinematic detail page: full-bleed backdrop, metadata, Play / Resume, and
// the available versions — matching Marquee's web detail view.
struct MovieDetailView: View {
    @EnvironmentObject var store: Store
    let movieId: Int

    @State private var detail: MovieDetail?
    @State private var loading = true
    @State private var playing = false
    @State private var resumeFrom: Double = 0

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if let d = detail {
                content(d)
            } else if loading {
                ProgressView().scaleEffect(1.6)
            } else {
                Text("Couldn't load this title.").foregroundStyle(.secondary)
            }
        }
        .task { await load() }
        .fullScreenCover(isPresented: $playing) {
            if let d = detail, let f = d.bestFile, let url = store.streamURL(fileId: f.id) {
                PlayerView(url: url, startAt: resumeFrom,
                           movieId: d.id, duration: d.duration, store: store)
                    .ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private func content(_ d: MovieDetail) -> some View {
        ScrollView {
            ZStack(alignment: .bottomLeading) {
                ArtImage(url: d.backdrop ?? d.poster, aspect: 16.0 / 9.0)
                    .frame(height: 760).frame(maxWidth: .infinity).clipped()
                    .overlay {
                        LinearGradient(colors: [.clear, Theme.bg.opacity(0.6), Theme.bg],
                                       startPoint: .top, endPoint: .bottom)
                    }

                VStack(alignment: .leading, spacing: 20) {
                    Text(d.title).font(.system(size: 64, weight: .bold)).shadow(radius: 10)

                    HStack(spacing: 16) {
                        if let y = d.year { Chip(String(y)) }
                        if let r = d.rating, r > 0 { Chip(String(format: "★ %.1f", r)) }
                        if let rt = d.runtime, rt > 0 { Chip("\(rt) min") }
                        ForEach(d.genreList.prefix(4), id: \.self) { Chip($0) }
                    }

                    HStack(spacing: 24) {
                        Button {
                            resumeFrom = 0; playing = true
                        } label: {
                            Label("Play", systemImage: "play.fill").font(.headline).padding(.horizontal, 16)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.accent)

                        if let p = d.resumePosition, p > 30 {
                            Button {
                                resumeFrom = p; playing = true
                            } label: {
                                Label("Resume · \(timecode(p))", systemImage: "gobackward")
                                    .font(.headline).padding(.horizontal, 12)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.top, 6)

                    if let o = d.overview {
                        Text(o).font(.title3).foregroundStyle(.white.opacity(0.86))
                            .frame(maxWidth: 1200, alignment: .leading).padding(.top, 8)
                    }

                    if d.files.count > 1 {
                        Text("\(d.files.count) versions available")
                            .font(.callout).foregroundStyle(.secondary).padding(.top, 4)
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 60)
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    private func load() async {
        loading = true
        detail = await store.movieDetail(movieId)
        loading = false
    }
}

// Seconds -> H:MM or M:SS timecode.
func timecode(_ seconds: Double) -> String {
    let s = Int(seconds)
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec)
                 : String(format: "%d:%02d", m, sec)
}
