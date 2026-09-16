import os
import subprocess

repo_url = "https://github.com/logancyang/obsidian-copilot.git"
clone_dir = "C:/Users/X!-Carbon/Documents/antigravity/serene-darwin/copilot_clone"

subprocess.run(["git", "clone", repo_url, clone_dir])
