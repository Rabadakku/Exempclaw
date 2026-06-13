# packaging/homebrew/exempclaw.rb
# Template for the santanajb03/homebrew-tap repo (Formula/exempclaw.rb).
# Replace url/sha256 at each release — see docs/RELEASING.md.
require "language/node"

class Exempclaw < Formula
  desc "Claude-powered agent fleet with a friendly terminal UI"
  homepage "https://github.com/santanajb03/exempclaw"
  url "https://registry.npmjs.org/exempclaw/-/exempclaw-0.4.0.tgz"
  sha256 "REPLACE_WITH_SHA256_OF_TARBALL"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "exempclaw", shell_output("#{bin}/exempclaw --help")
  end
end
