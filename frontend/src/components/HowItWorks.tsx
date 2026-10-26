export function HowItWorks({
  onBack,
  onExample,
  limitationNote,
}: {
  onBack: () => void;
  onExample: () => void;
  limitationNote: string;
}) {
  return (
    <article className="how card">
      <button type="button" className="btn" onClick={onBack}>
        ← Back to the planner
      </button>
      <h1>How Rest Route works</h1>
      <p>
        Most map apps ask how fast you want to get somewhere. Rest Route asks
        how far you want to walk before you sit, and looks for the shortest walk
        that never goes farther than that between recorded seats.
      </p>

      <div className="notice">
        <strong>Try it with an example</strong>
        <p>
          Explore a fictional walking map to see how changing the rest distance
          changes the route.
        </p>
        <button className="btn" onClick={onExample}>
          Try an example walk
        </button>
      </div>
      <h2>Choose a place, anywhere</h2>
      <p>
        Search for a place or address with its city, or use the map to select
        your start and destination. We load a small walking area around your
        trip. The two points can be up to 3 km apart; walking distance may be
        longer. Loading a new area can take a minute or two.
      </p>
      <h2>The idea in four steps</h2>
      <ol>
        <li>
          <strong>Walking map.</strong> Sidewalks, footpaths and streets from
          OpenStreetMap become a network of connected pieces, each with a length
          in meters. Known stairs and private paths are left out.
        </li>
        <li>
          <strong>Seats.</strong> Benches recorded in OpenStreetMap are
          connected to mapped walkways when their attachment is unambiguous. The
          original imported Flushing dataset can also include NYC DOT seating
          records. Leaning bars, shelters without recorded seating, and seats
          with unclear locations are shown but not counted.
        </li>
        <li>
          <strong>Distances.</strong> For every pair of seats (and your start
          and destination) we find the shortest walk between them.
        </li>
        <li>
          <strong>Search.</strong> We keep only walks that are no longer than
          your limit and find the shortest chain from start to destination. If
          no chain fits, we find the route whose longest walk without a seat is
          as short as possible, then the shortest such route, and highlight the
          legs that are over your limit.
        </li>
      </ol>

      <h2>What the results mean</h2>
      <ul>
        <li>
          <strong>Within your selected limit:</strong> every leg between rests
          is at or under your number, using recorded seats and mapped paths.
        </li>
        <li>
          <strong>Limit not met:</strong> no route in the mapped area keeps
          every leg under your number. We tell you the smallest longest leg that
          is possible.
        </li>
        <li>
          <strong>Extra distance:</strong> how much farther the plan is than the
          plain shortest walk.
        </li>
      </ul>

      <h2>Propose a bench</h2>
      <p>
        The "Try adding a bench" panel under Map options & experiments lets you
        place up to three hypothetical benches on mapped walkways and see how
        one trip would change, with a with/without comparison. Hypothetical
        benches are a planning experiment: they are not real seats, they are not
        saved, and the result does not mean a bench could or should be installed
        there.
      </p>

      <h2>Limits of the data</h2>
      <p>{limitationNote}</p>
      <ul>
        <li>
          A rest resets the distance count in the plan. It is a planning
          preference, not a medical estimate.
        </li>
        <li>
          Rest Route does not judge whether a route is safe or accessible, and
          it does not check curbs or slopes.
        </li>
        <li>
          Results only cover the area outlined on the map and the seats that
          were imported. A real bench that is missing from the data cannot be
          used.
        </li>
        <li>
          Seats marked "on record" have not been checked in person.
          "Field-checked" seats still may be occupied.
        </li>
      </ul>

      <h2>Privacy</h2>
      <p>
        Your start and destination are sent to the Rest Route server to compute
        the route and are not written to application logs. New area requests
        send a surrounding map boundary to OpenStreetMap’s Overpass service;
        cached areas are reused for up to seven days. Place searches are sent to
        Photon and cached temporarily in server memory. The map service receives
        requests for the map area you are viewing. Your location is only
        requested if you press "Use my location". Only your rest-distance
        setting is saved in this browser.
      </p>

      <h2>Data sources</h2>
      <ul>
        <li>
          Walking network and benches: © OpenStreetMap contributors, available
          under the Open Database License (
          <a href="https://www.openstreetmap.org/copyright">
            openstreetmap.org/copyright
          </a>
          ).
        </li>
        <li>
          Seating: NYC DOT "Seating Locations" on NYC Open Data (
          <a href="https://data.cityofnewyork.us/Transportation/Seating-Locations/esmy-s8q5">
            esmy-s8q5
          </a>
          ).
        </li>
      </ul>
    </article>
  );
}
