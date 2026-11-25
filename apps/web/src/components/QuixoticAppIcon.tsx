import appIconUrl from "../../../../assets/prod/quixotic-web-apple-touch-180.png";

/** Renders the production Quixotic application icon. */
export function QuixoticAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
