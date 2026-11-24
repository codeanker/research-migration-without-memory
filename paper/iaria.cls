


\NeedsTeXFormat{LaTeX2e}

\ProvidesClass{iaria}[2026/02/24 IARIA template v0.9.1]

\newcounter{iaria@subfigtracker}
\newcounter{iaria@subcaptiontracker}
\newcounter{iaria@pbalancetracker}
\newcounter{iaria@flushendtracker}


\DeclareOption{subfig}{
  \setcounter{iaria@subfigtracker}{1}
  \typeout{iaria class: subfig option is set (use subfloat command).}
}
\DeclareOption{subcaption}{
  \setcounter{iaria@subcaptiontracker}{1}
  \typeout{iaria class: subcaption option is set (use subfigure command).}
}

\DeclareOption{onecolumn}{\OptionNotUsed}

\DeclareOption{pbalance}{
  \setcounter{iaria@pbalancetracker}{1}
  \typeout{iaria class: pbalance option is set.}
}
\DeclareOption{flushend}{
  \setcounter{iaria@flushendtracker}{1}
  \typeout{iaria class: flushend option is set.}
}

\DeclareOption*{%
  \PassOptionsToClass{\CurrentOption}{IEEEtran}
}

\ProcessOptions\relax

\LoadClass{IEEEtran}


\RequirePackage{times} % Times New Roman

\RequirePackage[utf8]{inputenc}

\RequirePackage[T1]{fontenc}

\RequirePackage{graphicx}
\RequirePackage{xcolor}

\RequirePackage{url}
\RequirePackage{orcidlink}
\RequirePackage{hyperref}
\hypersetup{hidelinks,unicode}

\RequirePackage[
  style=ieee,
  citestyle=ieee-comp, % by default, activate cite compression
  backend=biber
]{biblatex}

\ExecuteBibliographyOptions{
  defernumbers=true,
  hyperref,
  maxnames=5,
  minnames=1,
  maxcitenames=2,
  mincitenames=1,
  %%% IARIA requires format for "Accessed: " dates in YYYY-MM-DD
  %urldate=iso8601, % DEPRECATED, use iso
  urldate=iso, % iso requires also seconds=true
  seconds=true
}

\makeatletter
\let\blx@rerun@biber\relax
\makeatother

\renewcommand*{\multicitedelim}{}    % for ieee-comp

\renewcommand*{\bibfont}{\small}

\DeclareRedundantLanguages{en}{english,american,british,
  canadian,australian,newzealand,USenglish,UKenglish}

\DeclareBibliographyDriver{online}{%
  \usebibmacro{bibindex}%
  \usebibmacro{begentry}%
  \usebibmacro{author/editor+others/translator+others}
  \setunit{\labelnamepunct}\newblock
  \usebibmacro{title}%
  \newunit
  \printlist{language}%
  \newunit\newblock
  \usebibmacro{byauthor}%
  \newunit\newblock
  \usebibmacro{byeditor+others}%
  \newunit\newblock
  \printfield{version}%
  \newunit
  \printfield{note}%
  \newunit\newblock
  \printlist{organization}
  \newunit\newblock
  \usebibmacro{date}%
  \newunit\newblock
  \iftoggle{bbx:eprint}
  {\usebibmacro{eprint}}
  {}%
  \newunit\newblock
  \usebibmacro{url+urldate}%
  \newunit\newblock
  \usebibmacro{addendum+pubstate}%
  \setunit{\bibpagerefpunct}\newblock
  \usebibmacro{pageref}%
  \usebibmacro{finentry}}

\makeatletter
\renewcommand{\fnum@figure}{Figure~\thefigure}
\renewcommand{\title}[1]{\renewcommand{\@title}{\bfseries\Large #1}}
\renewcommand\IEEEkeywordsname{Keywords}
\makeatother

\RequirePackage{xpatch}
\xpatchcmd\IEEEkeywords{---}{-}{}{}

\let\oldIEEEkeywords\IEEEkeywords
\def\IEEEkeywords{\oldIEEEkeywords\itshape\ignorespaces}

\makeatletter
\renewcommand{\IEEEauthorblockN}[1]{%
    \relax\@IEEEauthorblockNstyle% set the default text style
    \gdef\@IEEEauthorblockXinterlinespace{0pt}% disable strut for spacer row
    \if@IEEEprevauthorblockincol\expandafter\@IEEEauthorblockNtopspaceline\fi
    \global\@IEEEprevauthorblockincoltrue% we now have a block in this column
    \gdef\@IEEEauthorblockXinterlinespace{\@IEEEauthorblockNinterlinespace}%
    \large
    #1%
    \crcr}
\makeatother

\usepackage{etoolbox}
\makeatletter
\patchcmd{\@makecaption}
  {\\}
  {.\ }
  {}
  {}
\makeatother

\RequirePackage{caption}
\captionsetup[table]{
  style=base,
  name=TABLE,
  position=auto, % position option is NOT about forcing the label above/below, but ONLY about spacing!
  justification=centering,
  labelsep=period,
  textfont={footnotesize, sc},
  labelfont=footnotesize}
\captionsetup[figure]{
  style=base,
  position=auto, % position option is NOT about forcing the label above/below, but ONLY about spacing!
  justification=centering,
  labelsep=period,
  font={footnotesize,rm}}
\RequirePackage{floatrow}
\floatsetup[table]{capposition=top,captionskip=5pt}
\floatsetup[figure]{capposition=bottom,captionskip=8pt}

\ifnum\value{iaria@subfigtracker}=1
  \typeout{iaria class: load subfig package (use subfloat command).}
  \RequirePackage[caption=false,font=footnotesize]{subfig}
\fi
\ifnum\value{iaria@subcaptiontracker}=1
  \typeout{iaria class: load subcaption package (use subfigure command).}
  \RequirePackage{subcaption}
  % IARIA requires subfigure caption to number them with
  % parentheses around latin chars (like "(a)" and "(b)")
  \captionsetup[subfigure]{labelformat=parens,font=footnotesize}
\fi

\ifnum\value{iaria@pbalancetracker}=1
  \typeout{iaria class: load pbalance package.}
  \RequirePackage{pbalance}
\fi
\ifnum\value{iaria@flushendtracker}=1
  \typeout{iaria class: load flushend package.}
  \RequirePackage{flushend}
\fi


\RequirePackage[shortcuts]{extdash}

\endinput
%%
%% End of file `iaria.cls'.
