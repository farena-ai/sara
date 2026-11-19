# Homebrew cask for Sara's Mac app (Phase 57). It lives in the tap repository farena-ai/homebrew-tap
# as Casks/sara.rb; scripts/update-packaging.ts fills version and sha256 from the release's SHA256SUMS.
#   brew install --cask farena-ai/tap/sara
cask "sara" do
  version "3.34.0"
  sha256 "b9390ebc607be2acd47ced012a4dd0b1f6c71df6321da988bdfffcddf7aa1699"

  url "https://github.com/farena-ai/sara/releases/download/v#{version}/Sara-#{version}.dmg",
      verified: "github.com/farena-ai/sara/"
  name "Sara"
  desc "Self-hosted AI companion and coding partner"
  homepage "https://sara.backstagecoding.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "Sara.app"

  # Her server runs as a login item of the app (SMAppService); stop it before the app is removed.
  uninstall launchctl: "com.backstagecoding.sara.server",
            quit:      "com.backstagecoding.sara.desktop"

  # `brew uninstall --zap` also deletes her data (memories, keys, chats). Back up first:
  # sara backup
  zap trash: [
    "~/Library/Application Support/Sara",
    "~/Library/Preferences/com.backstagecoding.sara.desktop.plist",
    "~/Library/Saved Application State/com.backstagecoding.sara.desktop.savedState",
  ]
end
