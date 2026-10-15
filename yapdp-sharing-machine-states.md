# Sharing machine states

yaPDP machine states are more than save files. They let you share a
working moment of a historical computer: a game ready to start, a
program stopped at an interesting point, an operating system partway
through a task, or a demonstration of a peripheral.

Instead of asking somebody to install an emulator, find the right disk
images, configure the hardware and repeat a sequence of boot commands,
you can give them a state that captures the machine at the point you
want them to see. Add a title, a short explanation, an optional
screenshot and, when useful, a command to type after restoration. The
recipient can then explore the same starting point and continue from
there.

This makes sharing states a form of collaboration. You can exchange game
progress, reproduce an unusual behaviour, prepare a lesson or museum
exhibit, or show somebody a particular moment in the life of the
machine. A state is the starting point; your description and optional
guided steps explain what is interesting and what to try next.

## Choose how to share

There are two practical approaches. Choose based on whether you are
publishing a collection of states or sharing one state quickly.

  -----------------------------------------------------------------------
  Method                  Best for                What you need
  ----------------------- ----------------------- -----------------------
  A public GitHub         A collection of states  A public repository and
  repository              that you want to keep   a stable URL for each
                          organised and maintain  state
                          over time               

  GitHub Gist             Sharing one state or a  A GitHub account and a
                          small number of states  Personal Access Token
                          with minimal setup      with the `gist` scope
                                                  to create a Gist from
                                                  yaPDP

  A state file or text    Sending a state         A way to attach a file
  envelope                directly to another     or transfer text
                          person, for example in  
                          a chat or issue         
  -----------------------------------------------------------------------

## Option 1: Host a collection in a public GitHub repository

If you expect to create and share multiple states, a public GitHub
repository is often the simplest low-cost solution. It gives you a
stable place to keep files, descriptive names, a README, screenshots and
notes. You can organise states into folders and update the collection
using the normal Git workflow.

For example, a repository could contain:

``` text
yapdp-states/
├── README.md
├── games/
│   ├── space-invaders.state.zst
│   └── adventure.state.zst
├── operating-systems/
│   └── bsd-build.state.zst
└── peripherals/
    └── paper-tape-demo.state.zst
```

The example above is only an organisational suggestion; use any
structure that suits your collection.

For direct `?state=` links, the state file must be available at a URL
that the browser can fetch. GitHub Pages is a convenient option for a
public static collection. Before relying on a link, test it from the
published site rather than assuming that every GitHub URL serves a raw
file in the required way.

### The CORS requirement

When yaPDP is opened with a URL such as:

``` text
https://amesk.github.io/yaPDP/pdp11.html?state=https://example.org/states/space-invaders.state.zst
```

the browser must fetch the state from `example.org` while the emulator
page is running on `amesk.github.io`. Because these are different
origins, the host serving the state must permit that cross-origin read
using CORS headers, typically `Access-Control-Allow-Origin`.

This is a browser security rule, not a restriction specific to yaPDP. A
file can open or download normally in a new tab and still be unreadable
to JavaScript running on another site if the server does not permit
CORS. A link that works when tested by opening the file directly is
therefore not sufficient proof that a `?state=` link will work.

The simplest reliable arrangement is to serve the state from the same
site as the emulator, as yaPDP does for its own files under `states/`.
If you host the files elsewhere, verify that the host allows
cross-origin requests from the yaPDP site. Do not assume that an
arbitrary file host, repository URL or cloud-storage link has the right
headers.

A direct state link also does not include every disk image used by the
machine. The recipient must have the disk images referenced by the
state. A state that depends on standard images bundled with yaPDP is
easier to share than one that depends on a custom disk image that exists
only in your browser.

## Option 2: Share through GitHub Gist

A GitHub Gist is a convenient alternative when you want to share one
state without maintaining a repository. Gist is designed for text
snippets, while yaPDP's `.state.zst` file is binary. yaPDP bridges that
difference by converting the state into a text envelope.

The envelope begins with a format marker:

``` text
yapdp-text-envelope-v1
```

The remaining lines contain the original `.state.zst` bytes encoded as
Base64. This makes the state suitable for a text-oriented service such
as GitHub Gist. Base64 increases the size by roughly one third, so a
text envelope is convenient for occasional sharing but is less efficient
than keeping binary state files in a repository.

### Create a Gist from yaPDP

1.  Open the **Machine state** dialog and select the state you want to
    share.
2.  Choose **Share** and fill in the title and description. Add a
    screenshot or a short instruction if it helps explain the situation.
3.  Open the menu next to **Create Shareable State** and choose **Create
    GitHub Gist**.
4.  Follow the dialog instructions. Creating a Gist requires a GitHub
    Personal Access Token with the `gist` scope.
5.  Generate the Gist and use the resulting shareable link. You can copy
    or test the link before sending it to someone.

The token is used to create the Gist through the GitHub API. Treat it as
a credential: create a token with only the required scope, do not paste
it into a public document or share it with the state, and clear the
locally saved token when you no longer want yaPDP to retain it. Consult
the in-app **About GitHub Personal Access Token** dialog for the current
details of how yaPDP handles the token.

Gist is especially useful for quick exchanges: send a link in a chat,
issue or discussion, and the recipient can retrieve the text envelope
and import it into yaPDP. You do not need to set up a separate hosting
project just to share a single prepared state.

## Option 3: Send a state directly

If you do not need a permanent public link, you can transfer the state
directly:

-   **Export** downloads the binary `.state.zst` file. This is usually
    the most compact option.
-   **Save as text file** creates a `.state.txt` text envelope that can
    pass through channels that reject binary attachments.
-   **Copy text to clipboard** copies the envelope so you can paste it
    into a message or text-oriented service.
-   On the receiving side, use **Import** to select a file, **Import
    from clipboard** to paste an envelope, or **Import from URL** to
    retrieve a hosted state.

A direct file transfer does not require a web server or CORS. CORS
matters when the browser-based emulator must fetch the state from a
different website as part of a `?state=` link or URL import.

## What the recipient should know

A shared state is a reproducible starting point, not necessarily a
self-contained copy of every piece of media used by the machine.

-   The recipient needs the disk images referenced by the state.
    Standard images shipped with yaPDP are the easiest choice for
    portable examples.
-   A shared state can include explanatory metadata and guided-restore
    information. Use the title and description to say what the recipient
    is about to see; use a screenshot when the visual result is
    important.
-   If the state represents a game or an experiment, explain what to try
    next. A useful shared state should reduce setup work and invite
    exploration.
-   If a direct URL does not restore, try importing the state file or
    text envelope. This separates problems with hosting/CORS from
    problems with the state itself.

## A practical rule of thumb

-   **Building a collection?** Put binary `.state.zst` files in a public
    repository and publish them from a host that supports the required
    cross-origin access.
-   **Sharing one state quickly?** Use yaPDP's GitHub Gist workflow.
-   **Sending something privately or through a channel that blocks
    attachments?** Export a text envelope and transfer it as text.
-   **Need the least overhead?** Export the binary file and send it
    directly.

The point is not merely to transfer a file. It is to make a particular
moment in a historical computing environment easy for another person to
reach, understand and explore.
