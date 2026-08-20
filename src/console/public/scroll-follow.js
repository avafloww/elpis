(() => {
  function createScrollFollower(scroller, button, threshold = 80) {
    let following = true;
    let expectedTop = null;

    function render() { button.hidden = following; }
    function isAtBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < threshold; }
    function sync() {
      if (following && expectedTop !== null && Math.abs(scroller.scrollTop - expectedTop) <= 1) {
        expectedTop = null;
        render();
        return;
      }
      expectedTop = null;
      following = isAtBottom();
      render();
    }
    function toLatest() {
      following = true;
      scroller.scrollTop = scroller.scrollHeight;
      expectedTop = scroller.scrollTop;
      render();
    }
    function capture() { return { following, scrollTop: scroller.scrollTop }; }
    function restore(position) {
      following = position.following;
      if (following) toLatest();
      else { scroller.scrollTop = position.scrollTop; render(); }
    }
    function afterGrowth() { if (following) toLatest(); else render(); }

    scroller.addEventListener('scroll', sync);
    button.addEventListener('click', toLatest);
    render();
    return Object.freeze({ isFollowing: () => following, sync, toLatest, capture, restore, afterGrowth });
  }

  window.ElpisScrollFollow = Object.freeze({ createScrollFollower });
})();
